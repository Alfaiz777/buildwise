import { AppError } from '../lib/errors.js';
import type { CommerceProvider } from '../ports/commerce.js';
import type { ConnectionRepository } from '../ports/repositories.js';
import {
  ShopifyApiError,
  type ShopifyAdminApi,
  type ShopifyConnectionStore,
  type ShopifyCredentials,
} from '../ports/shopify.js';
import { SHOPIFY_CONNECTION_ID } from './commerceSyncService.js';

/** Refresh an expiring access token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export const notConnected = () =>
  new AppError(409, 'SHOPIFY_NOT_CONNECTED', 'Connect your Shopify store first (Settings → Shopify).');
export const reconnectRequired = () =>
  new AppError(409, 'SHOPIFY_RECONNECT_REQUIRED', 'Shopify no longer accepts this connection. Reconnect Shopify.');

/**
 * A brand's live Shopify credentials (L2-Shopify): reads them from the server-only store,
 * refreshes an expiring offline token before it runs out, and turns a terminal 401 into
 * "reconnect" — the connection is marked ERROR and the brand connects again.
 */
export class ShopifyConnections {
  constructor(
    private readonly deps: {
      store: ShopifyConnectionStore;
      api: ShopifyAdminApi;
      connections: ConnectionRepository;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  get(brandId: string): Promise<ShopifyCredentials | null> {
    return this.deps.store.get(brandId);
  }

  async accessToken(brandId: string): Promise<string> {
    const creds = await this.deps.store.get(brandId);
    if (!creds) throw notConnected();
    const expiresAt = creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt).getTime() : null;
    if (expiresAt === null || expiresAt - this.now().getTime() > REFRESH_MARGIN_MS) return creds.accessToken;
    if (!creds.refreshToken) {
      await this.markReconnect(brandId);
      throw reconnectRequired();
    }
    try {
      const fresh = await this.deps.api.refresh(creds.shopDomain, creds.refreshToken);
      await this.deps.store.updateTokens(brandId, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken ?? creds.refreshToken,
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
        refreshTokenExpiresAt: fresh.refreshTokenExpiresAt ?? creds.refreshTokenExpiresAt,
      });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof ShopifyApiError && err.kind === 'UNAUTHORIZED') {
        await this.markReconnect(brandId);
        throw reconnectRequired();
      }
      throw err;
    }
  }

  /** The connection status record says "reconnect"; the stored tokens are useless now. */
  async markReconnect(brandId: string): Promise<void> {
    const c = await this.deps.connections.get(brandId, SHOPIFY_CONNECTION_ID);
    if (!c) return;
    await this.deps.connections.put({
      ...c,
      status: 'ERROR',
      lastError: { code: 'SHOPIFY_RECONNECT_REQUIRED', message: 'Shopify no longer accepts this connection.' },
    });
  }
}

/**
 * The CommerceProvider for one brand (L2-Shopify). Mock mode: the shared mock for every
 * brand. Shopify mode: a provider built from the brand's own stored connection, or
 * 409 SHOPIFY_NOT_CONNECTED.
 */
export class CommerceProviderResolver {
  constructor(
    private readonly deps:
      | { mode: 'mock'; mock: CommerceProvider }
      | {
          mode: 'shopify';
          connections: ShopifyConnections;
          create: (shop: string, accessToken: () => Promise<string>) => CommerceProvider;
        },
  ) {}

  get mode() {
    return this.deps.mode;
  }

  async forBrand(brandId: string): Promise<CommerceProvider> {
    if (this.deps.mode === 'mock') return this.deps.mock;
    const deps = this.deps;
    const creds = await deps.connections.get(brandId);
    if (!creds) throw notConnected();
    return deps.create(creds.shopDomain, () => deps.connections.accessToken(brandId));
  }

  /** The connected shop's domain and name (Shopify mode), for the connection record. */
  async shopInfo(brandId: string): Promise<{ shopDomain: string; shopName: string } | null> {
    if (this.deps.mode === 'mock') return null;
    const creds = await this.deps.connections.get(brandId);
    return creds ? { shopDomain: creds.shopDomain, shopName: creds.shopName } : null;
  }

  async onUnauthorized(brandId: string): Promise<void> {
    if (this.deps.mode === 'shopify') await this.deps.connections.markReconnect(brandId);
  }
}
