/**
 * L2-Shopify test doubles. No network: FakeShopify answers the real ShopifyHttpAdminApi's
 * requests from recorded fixtures (test/fixtures/shopify) and records what was sent.
 * MemoryShopifyStore seals tokens with the real TokenCipher, like the Firestore store.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TokenCipher, type SealedSecret } from '../src/lib/tokenCipher.js';
import type { OAuthNonce, ShopifyConnectionStore, ShopifyCredentials } from '../src/ports/shopify.js';

export const SHOPIFY_TEST_APP = {
  apiKey: 'test-client-id',
  apiSecret: ['test', 'shopify', 'client', 'secret', '0123456789'].join('-'),
  scopes: 'read_products,read_inventory,read_customers,read_orders',
  apiVersion: '2026-10',
  publicBackendUrl: 'https://tunnel.example.test',
  frontendUrl: 'http://localhost:5173',
  encryptionKey: Buffer.alloc(32, 7),
};
export const TEST_SHOP = 'aquaskin-test.myshopify.com';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/shopify/${name}`, import.meta.url), 'utf8')) as unknown;

/** What FakeShopify saw (bodies only — tokens included, so tests can assert on them). */
export interface SeenRequest {
  url: string;
  operation: string | null;
  body: string;
  accessToken: string | null;
  variables: Record<string, unknown>;
}

export class FakeShopify {
  readonly seen: SeenRequest[] = [];
  /** GraphQL operation name → queued responses (status, JSON); falls back to the defaults below. */
  readonly queued = new Map<string, { status: number; body: unknown }[]>();
  /** Webhook subscriptions currently registered in the fake store. */
  readonly webhooks: { id: string; topic: string; uri: string }[] = [];
  tokenCounter = 0;
  /** The token endpoint's next answer (status); 200 issues a new expiring token. */
  tokenStatus = 200;
  /** Access tokens Shopify now rejects (401). */
  readonly revoked = new Set<string>();
  /** The store's orders (GraphQL node shape) for QwikspotOrders. */
  readonly orders: unknown[] = [];
  /** Variant GID → availableForSale for QwikspotOnlineAvailability (unlisted → true). */
  readonly availableForSale = new Map<string, boolean>();

  queue(operation: string, body: unknown, status = 200) {
    const list = this.queued.get(operation) ?? [];
    list.push({ status, body });
    this.queued.set(operation, list);
  }

  get operations() {
    return this.seen.map((s) => s.operation);
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = String(init.body ?? '');
    const headers = new Headers(init.headers);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.endsWith('/admin/oauth/access_token')) {
      this.seen.push({ url, operation: 'TOKEN', body, accessToken: null, variables: {} });
      if (this.tokenStatus !== 200) return json(this.tokenStatus, { error: 'invalid_request' });
      this.tokenCounter += 1;
      return json(200, {
        access_token: `shpua_test_access_${this.tokenCounter}`,
        scope: SHOPIFY_TEST_APP.scopes,
        expires_in: 3600,
        refresh_token: `shprt_test_refresh_${this.tokenCounter}`,
        refresh_token_expires_in: 7776000,
      });
    }

    const parsed = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? null;
    const accessToken = headers.get('X-Shopify-Access-Token');
    this.seen.push({ url, operation, body, accessToken, variables: parsed.variables ?? {} });
    if (accessToken && this.revoked.has(accessToken)) return json(401, { errors: 'Invalid API key or access token' });

    const next = operation ? this.queued.get(operation)?.shift() : undefined;
    if (next) return json(next.status, next.body);

    switch (operation) {
      case 'QwikspotShop':
        return json(200, { data: { shop: { name: 'AquaSkin', myshopifyDomain: TEST_SHOP, currencyCode: 'INR' } } });
      case 'QwikspotProducts':
        return json(200, fixture(parsed.variables?.after ? 'products-page-2.json' : 'products-page-1.json'));
      case 'QwikspotOrders':
        return json(200, {
          data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.orders } },
        });
      case 'QwikspotOnlineAvailability': {
        const id = String(parsed.variables?.id);
        return json(200, { data: { productVariant: { id, availableForSale: this.availableForSale.get(id) ?? true } } });
      }
      case 'QwikspotWebhooks':
        return json(200, { data: { webhookSubscriptions: { nodes: this.webhooks } } });
      case 'QwikspotWebhook': {
        const v = parsed.variables as { topic: string; sub: { uri: string } };
        const id = `gid://shopify/WebhookSubscription/${this.webhooks.length + 1}`;
        this.webhooks.push({ id, topic: v.topic, uri: v.sub.uri });
        return json(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id }, userErrors: [] } } });
      }
      case 'QwikspotWebhookDelete': {
        const id = String(parsed.variables?.id);
        const i = this.webhooks.findIndex((w) => w.id === id);
        if (i >= 0) this.webhooks.splice(i, 1);
        return json(200, {
          data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: id, userErrors: [] } },
        });
      }
      default:
        return json(200, { errors: [{ message: `unexpected operation ${operation}` }] });
    }
  };
}

/** In-memory ShopifyConnectionStore that keeps tokens sealed, so tests can inspect the stored form. */
export class MemoryShopifyStore implements ShopifyConnectionStore {
  readonly secrets = new Map<string, Record<string, unknown>>();
  readonly shops = new Map<string, string>();
  readonly nonces = new Map<string, OAuthNonce>();
  constructor(private readonly cipher = new TokenCipher(SHOPIFY_TEST_APP.encryptionKey)) {}

  async get(brandId: string): Promise<ShopifyCredentials | null> {
    const d = this.secrets.get(brandId);
    if (!d) return null;
    return {
      brandId,
      shopDomain: d.shop_domain as string,
      shopName: d.shop_name as string,
      accessToken: this.cipher.open(d.access_token as SealedSecret),
      refreshToken: d.refresh_token ? this.cipher.open(d.refresh_token as SealedSecret) : null,
      accessTokenExpiresAt: (d.access_token_expires_at as string) ?? null,
      refreshTokenExpiresAt: (d.refresh_token_expires_at as string) ?? null,
      scopes: d.scopes as string,
      installedAt: d.installed_at as string,
    };
  }

  async save(c: ShopifyCredentials): Promise<boolean> {
    const holder = this.shops.get(c.shopDomain);
    if (holder && holder !== c.brandId) return false;
    const old = this.secrets.get(c.brandId)?.shop_domain as string | undefined;
    if (old && old !== c.shopDomain) this.shops.delete(old);
    this.shops.set(c.shopDomain, c.brandId);
    this.secrets.set(c.brandId, {
      shop_domain: c.shopDomain,
      shop_name: c.shopName,
      access_token: this.cipher.seal(c.accessToken),
      refresh_token: c.refreshToken ? this.cipher.seal(c.refreshToken) : null,
      access_token_expires_at: c.accessTokenExpiresAt,
      refresh_token_expires_at: c.refreshTokenExpiresAt,
      scopes: c.scopes,
      installed_at: c.installedAt,
    });
    return true;
  }

  async updateTokens(
    brandId: string,
    t: Pick<ShopifyCredentials, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>,
  ) {
    const d = this.secrets.get(brandId);
    if (!d) return;
    Object.assign(d, {
      access_token: this.cipher.seal(t.accessToken),
      refresh_token: t.refreshToken ? this.cipher.seal(t.refreshToken) : null,
      access_token_expires_at: t.accessTokenExpiresAt,
      refresh_token_expires_at: t.refreshTokenExpiresAt,
    });
  }

  async delete(brandId: string) {
    const d = this.secrets.get(brandId);
    if (!d) return;
    if (this.shops.get(d.shop_domain as string) === brandId) this.shops.delete(d.shop_domain as string);
    this.secrets.delete(brandId);
  }

  async brandForShop(shop: string) {
    return this.shops.get(shop) ?? null;
  }

  async saveNonce(nonce: string, value: OAuthNonce) {
    this.nonces.set(nonce, value);
  }

  async consumeNonce(nonce: string) {
    const v = this.nonces.get(nonce) ?? null;
    this.nonces.delete(nonce);
    return v;
  }
}

/** Shopify's callback query, signed like Shopify signs it (sorted params, HMAC-SHA256 hex). */
export function signedCallback(params: Record<string, string>, secret = SHOPIFY_TEST_APP.apiSecret) {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return { ...params, hmac: createHmac('sha256', secret).update(message).digest('hex') };
}

/** A webhook body's X-Shopify-Hmac-Sha256. */
export const webhookHmac = (raw: string, secret = SHOPIFY_TEST_APP.apiSecret) =>
  createHmac('sha256', secret).update(raw).digest('base64');
