import { ShopifyApiError, type ShopifyAdminApi, type ShopifyTokenSet } from '../../ports/shopify.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface TokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message?: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
    };
  };
}

/**
 * Shopify's OAuth token endpoint and GraphQL Admin API over HTTPS (L2-Shopify; docs/06
 * §17.1). The API version is pinned by config. Throttled calls wait for the cost bucket
 * to refill (restore rate) and retry, then give up with THROTTLED. Errors never carry
 * the provider's message, a token or the client secret.
 */
export class ShopifyHttpAdminApi implements ShopifyAdminApi {
  private readonly fetch: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly app: { apiKey: string; apiSecret: string; apiVersion: string },
    options: { fetch?: FetchFn; sleep?: (ms: number) => Promise<void>; now?: () => Date; maxRetries?: number } = {},
  ) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
    this.maxRetries = options.maxRetries ?? 5;
  }

  private readonly maxRetries: number;

  exchangeCode(shop: string, code: string): Promise<ShopifyTokenSet> {
    // `expiring=1`: an expiring offline token with a refresh token (the current Shopify default).
    return this.token(shop, { client_id: this.app.apiKey, client_secret: this.app.apiSecret, code, expiring: '1' });
  }

  refresh(shop: string, refreshToken: string): Promise<ShopifyTokenSet> {
    return this.token(shop, {
      client_id: this.app.apiKey,
      client_secret: this.app.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  private async token(shop: string, form: Record<string, string>): Promise<ShopifyTokenSet> {
    let res: Response;
    try {
      res = await this.fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new ShopifyApiError('FAILED', 'Shopify could not be reached.');
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ShopifyApiError('UNAUTHORIZED', 'Shopify refused the token request.');
    }
    if (!res.ok) throw new ShopifyApiError('FAILED', 'Shopify could not issue a token.');
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!body.access_token) throw new ShopifyApiError('FAILED', 'Shopify returned no token.');
    const at = this.now().getTime();
    const plus = (s: number | undefined) =>
      typeof s === 'number' && s > 0 ? new Date(at + s * 1000).toISOString() : null;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      accessTokenExpiresAt: plus(body.expires_in),
      refreshTokenExpiresAt: plus(body.refresh_token_expires_in),
      scopes: body.scope ?? '',
    };
  }

  async graphql<T>(shop: string, accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${shop}/admin/api/${this.app.apiVersion}/graphql.json`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
        });
      } catch {
        throw new ShopifyApiError('FAILED', 'Shopify could not be reached.');
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyApiError('UNAUTHORIZED', 'Shopify no longer accepts this connection.');
      }
      const body = (await res.json().catch(() => ({}))) as GraphqlResponse<T>;
      const throttled = res.status === 429 || (body.errors ?? []).some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled) {
        if (attempt >= this.maxRetries) throw new ShopifyApiError('THROTTLED', 'Shopify is busy. Try again shortly.');
        await this.sleep(this.waitMs(body, attempt));
        continue;
      }
      if (!res.ok || body.errors?.length || body.data === undefined) {
        throw new ShopifyApiError('FAILED', 'Shopify returned an error.');
      }
      return body.data;
    }
  }

  /** Time for the bucket to hold the query's cost again, never less than an exponential floor. */
  private waitMs(body: GraphqlResponse<unknown>, attempt: number): number {
    const floor = Math.min(500 * 2 ** attempt, 8_000);
    const cost = body.extensions?.cost;
    const restore = cost?.throttleStatus?.restoreRate;
    const needed = (cost?.requestedQueryCost ?? 0) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
    if (restore && restore > 0 && needed > 0)
      return Math.max(floor, Math.min(Math.ceil((needed / restore) * 1000), 10_000));
    return floor;
  }
}
