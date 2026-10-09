import { randomBytes } from 'node:crypto';
import {
  normalizeShopDomain,
  OAUTH_STATE_TTL_MS,
  readState,
  signState,
  verifyCallbackHmac,
} from '../domain/shopifyOAuth.js';
import type { BrandPrincipal } from '../domain/principal.js';
import { AppError } from '../lib/errors.js';
import type { AuditRepository, ConnectionRecord, ConnectionRepository } from '../ports/repositories.js';
import { ShopifyApiError, type ShopifyAdminApi, type ShopifyConnectionStore } from '../ports/shopify.js';
import { SHOPIFY_CONNECTION_ID } from './commerceSyncService.js';

export interface ShopifyAppSettings {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  publicBackendUrl: string;
  frontendUrl: string;
}

/** Callback failures, as the `reason` the Settings page explains in plain words. */
export type CallbackFailure =
  | 'INVALID_HMAC'
  | 'INVALID_STATE'
  | 'STATE_EXPIRED'
  | 'SHOP_MISMATCH'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'SHOP_ALREADY_CONNECTED'
  | 'WEBHOOKS_FAILED';

/** The webhooks Qwikspot needs (docs/06 §8, §8.1). */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_CANCELLED',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'APP_UNINSTALLED',
] as const;
export const WEBHOOK_PATH = '/api/webhooks/shopify';
export const CALLBACK_PATH = '/api/integrations/shopify/callback';

const SHOP_QUERY = `query QwikspotShop { shop { name myshopifyDomain currencyCode } }`;
const LIST_WEBHOOKS = `query QwikspotWebhooks { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`;
const CREATE_WEBHOOK = `mutation QwikspotWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;
const DELETE_WEBHOOK = `mutation QwikspotWebhookDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
}`;

/**
 * Shopify OAuth (L2-Shopify; docs/06 §9, docs/07 §9). The authorization-code grant for an
 * expiring offline token: a signed, single-use, 10-minute `state` bound to the brand, the
 * user and the shop; a timing-safe check of the callback's HMAC; the token exchanged and
 * stored encrypted server-side; idempotent webhook subscriptions. The browser only ever
 * sees the authorize URL and a redirect with a status — never a token or the secret.
 */
export class ShopifyAuthService {
  constructor(
    private readonly deps: {
      app: ShopifyAppSettings;
      store: ShopifyConnectionStore;
      api: ShopifyAdminApi;
      connections: ConnectionRepository;
      audit: AuditRepository;
      now?: () => Date;
      nonce?: () => string;
      /** The brand's current access token, refreshed when about to expire (ShopifyConnections.accessToken). */
      accessToken?: (brandId: string) => Promise<string>;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private audit(
    brandId: string,
    actor: { type: 'USER' | 'SYSTEM'; id: string },
    action: string,
    reason: string | null,
  ) {
    return this.deps.audit.recordBrandEvent({
      brandId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      targetType: 'CONNECTION',
      targetId: SHOPIFY_CONNECTION_ID,
      result: reason && reason !== 'OK' ? 'FAILED' : 'SUCCESS',
      reasonCode: reason,
    });
  }

  /** POST /api/integrations/shopify/connect { shop } → { authorize_url }. */
  async connect(principal: BrandPrincipal, rawShop: unknown): Promise<{ authorizeUrl: string }> {
    const shop = normalizeShopDomain(rawShop);
    if (!shop) {
      throw new AppError(
        400,
        'INVALID_SHOP_DOMAIN',
        'Enter your store’s myshopify.com domain, e.g. your-store.myshopify.com.',
      );
    }
    const nonce = (this.deps.nonce ?? (() => randomBytes(18).toString('base64url')))();
    const exp = this.now().getTime() + OAUTH_STATE_TTL_MS;
    await this.deps.store.saveNonce(nonce, {
      brandId: principal.brandId,
      userId: principal.userId,
      shop,
      expiresAt: new Date(exp).toISOString(),
    });
    const state = signState(
      { nonce, brandId: principal.brandId, userId: principal.userId, shop, exp },
      this.deps.app.apiSecret,
    );
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set('client_id', this.deps.app.apiKey);
    url.searchParams.set('scope', this.deps.app.scopes);
    url.searchParams.set('redirect_uri', `${this.deps.app.publicBackendUrl}${CALLBACK_PATH}`);
    url.searchParams.set('state', state);
    await this.audit(principal.brandId, { type: 'USER', id: principal.userId }, 'SHOPIFY_CONNECT_STARTED', null);
    return { authorizeUrl: url.toString() };
  }

  private settingsUrl(params: Record<string, string>) {
    const url = new URL('/brand/settings', this.deps.app.frontendUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** GET /api/integrations/shopify/callback → where to redirect the browser. Never throws. */
  async callback(query: Record<string, string>): Promise<string> {
    const fail = (reason: CallbackFailure) => this.settingsUrl({ shopify: 'error', reason });
    if (!verifyCallbackHmac(query, this.deps.app.apiSecret)) return fail('INVALID_HMAC');
    const checked = readState(query.state, this.deps.app.apiSecret, this.now().getTime());
    if (!checked.ok) return fail(checked.reason);
    const { state } = checked;
    // Single use: the nonce is deleted the first time; a replayed callback finds nothing.
    const stored = await this.deps.store.consumeNonce(state.nonce);
    if (!stored || stored.brandId !== state.brandId || stored.userId !== state.userId) return fail('INVALID_STATE');
    if (new Date(stored.expiresAt).getTime() < this.now().getTime()) return fail('STATE_EXPIRED');
    const shop = normalizeShopDomain(query.shop);
    if (!shop || shop !== state.shop || stored.shop !== shop) return fail('SHOP_MISMATCH');
    if (typeof query.code !== 'string' || !query.code) return fail('INVALID_STATE');
    const actor = { type: 'USER' as const, id: state.userId };

    let shopName = shop;
    try {
      const tokens = await this.deps.api.exchangeCode(shop, query.code);
      try {
        const info = await this.deps.api.graphql<{ shop: { name: string } }>(shop, tokens.accessToken, SHOP_QUERY);
        shopName = info.shop.name?.trim() || shop;
      } catch {
        /* the name is cosmetic */
      }
      const saved = await this.deps.store.save({
        brandId: state.brandId,
        shopDomain: shop,
        shopName,
        ...tokens,
        installedAt: this.now().toISOString(),
      });
      if (!saved) {
        await this.audit(state.brandId, actor, 'SHOPIFY_CONNECTED', 'SHOP_ALREADY_CONNECTED');
        return fail('SHOP_ALREADY_CONNECTED');
      }
      await this.markConnected(state.brandId, shop, shopName);
      await this.audit(state.brandId, actor, 'SHOPIFY_CONNECTED', null);
      try {
        await this.registerWebhooks(shop, tokens.accessToken);
      } catch {
        await this.audit(state.brandId, actor, 'SHOPIFY_WEBHOOKS_REGISTERED', 'WEBHOOKS_FAILED');
        return fail('WEBHOOKS_FAILED');
      }
      return this.settingsUrl({ shopify: 'connected' });
    } catch (err) {
      if (err instanceof ShopifyApiError) {
        await this.audit(state.brandId, actor, 'SHOPIFY_CONNECTED', 'TOKEN_EXCHANGE_FAILED');
        return fail('TOKEN_EXCHANGE_FAILED');
      }
      throw err;
    }
  }

  private async markConnected(brandId: string, shopDomain: string, shopName: string) {
    const previous = await this.deps.connections.get(brandId, SHOPIFY_CONNECTION_ID);
    const record: ConnectionRecord = {
      connectionId: SHOPIFY_CONNECTION_ID,
      brandId,
      provider: 'SHOPIFY',
      source: 'SHOPIFY',
      status: 'CONNECTED',
      shopDomain,
      shopName,
      connectedAt: this.now().toISOString(),
      lastSyncAt: previous?.source === 'SHOPIFY' && previous.shopDomain === shopDomain ? previous.lastSyncAt : null,
      lastError: null,
      productCount: previous?.source === 'SHOPIFY' && previous.shopDomain === shopDomain ? previous.productCount : 0,
      variantCount: previous?.source === 'SHOPIFY' && previous.shopDomain === shopDomain ? previous.variantCount : 0,
    };
    await this.deps.connections.put(record);
  }

  /** Idempotent: creates each topic's subscription only if none points at our endpoint. */
  async registerWebhooks(shop: string, accessToken: string): Promise<void> {
    const uri = `${this.deps.app.publicBackendUrl}${WEBHOOK_PATH}`;
    const existing = await this.deps.api.graphql<{
      webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] };
    }>(shop, accessToken, LIST_WEBHOOKS);
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      if (existing.webhookSubscriptions.nodes.some((n) => n.topic === topic && n.uri === uri)) continue;
      const created = await this.deps.api.graphql<{
        webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: { message: string }[] };
      }>(shop, accessToken, CREATE_WEBHOOK, { topic, sub: { uri } });
      const r = created.webhookSubscriptionCreate;
      if (!r.webhookSubscription || r.userErrors.length > 0)
        throw new ShopifyApiError('FAILED', 'Webhook not created.');
    }
  }

  /**
   * Registers any topic a store connected by an earlier version lacks — after a Sync, so a
   * connected store gets new webhooks without reconnecting. Best effort: false on failure.
   */
  async ensureWebhooks(brandId: string): Promise<boolean> {
    try {
      const creds = await this.deps.store.get(brandId);
      if (!creds) return false;
      const token = this.deps.accessToken ? await this.deps.accessToken(brandId) : creds.accessToken;
      await this.registerWebhooks(creds.shopDomain, token);
      return true;
    } catch {
      return false;
    }
  }

  /** POST /api/integrations/shopify/disconnect. */
  async disconnect(principal: BrandPrincipal): Promise<ConnectionRecord> {
    const creds = await this.deps.store.get(principal.brandId).catch(() => null);
    if (creds) {
      // Best effort while the token still works; app/uninstalled covers the rest.
      try {
        const uri = `${this.deps.app.publicBackendUrl}${WEBHOOK_PATH}`;
        const list = await this.deps.api.graphql<{ webhookSubscriptions: { nodes: { id: string; uri: string }[] } }>(
          creds.shopDomain,
          creds.accessToken,
          LIST_WEBHOOKS,
        );
        for (const n of list.webhookSubscriptions.nodes.filter((x) => x.uri === uri)) {
          await this.deps.api.graphql(creds.shopDomain, creds.accessToken, DELETE_WEBHOOK, { id: n.id });
        }
      } catch {
        /* ignore */
      }
    }
    const record = await this.removeConnection(principal.brandId);
    await this.audit(principal.brandId, { type: 'USER', id: principal.userId }, 'SHOPIFY_DISCONNECTED', null);
    return record;
  }

  /** Deletes the stored token and marks the connection DISCONNECTED (disconnect and app/uninstalled). */
  async removeConnection(brandId: string): Promise<ConnectionRecord> {
    await this.deps.store.delete(brandId);
    const previous = await this.deps.connections.get(brandId, SHOPIFY_CONNECTION_ID);
    const record: ConnectionRecord = {
      connectionId: SHOPIFY_CONNECTION_ID,
      brandId,
      provider: 'SHOPIFY',
      source: previous?.source ?? 'SHOPIFY',
      status: 'DISCONNECTED',
      shopDomain: previous?.shopDomain ?? null,
      shopName: previous?.shopName ?? null,
      connectedAt: null,
      lastSyncAt: previous?.lastSyncAt ?? null,
      lastError: null,
      productCount: previous?.productCount ?? 0,
      variantCount: previous?.variantCount ?? 0,
    };
    await this.deps.connections.put(record);
    return record;
  }
}

export const shopifyNotConfigured = () =>
  new AppError(409, 'SHOPIFY_NOT_CONFIGURED', 'Shopify is not configured on this server (COMMERCE_PROVIDER=mock).');
