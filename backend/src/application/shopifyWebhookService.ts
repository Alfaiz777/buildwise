import { createHash } from 'node:crypto';
import { normalizeShopDomain, verifyWebhookHmac } from '../domain/shopifyOAuth.js';
import type { WebhookReceiptRepository } from '../ports/conversationRepositories.js';
import type { AuditRepository } from '../ports/repositories.js';
import type { ShopifyConnectionStore } from '../ports/shopify.js';
import { SHOPIFY_CONNECTION_ID } from './commerceSyncService.js';
import type { ShopifyAuthService } from './shopifyAuthService.js';
import type { ShopifyOrderInput, ShopifyOrderService } from './shopifyOrderService.js';

export interface WebhookHeaders {
  hmac?: string;
  topic?: string;
  shopDomain?: string;
  eventId?: string;
  webhookId?: string;
}

export type WebhookResult =
  | { status: 401; outcome: 'INVALID_HMAC' }
  | {
      status: 200;
      outcome:
        | 'UNKNOWN_SHOP'
        | 'DUPLICATE'
        | 'IGNORED'
        | 'ORDER_RECORDED'
        | 'ORDER_CANCELLED'
        | 'CATALOG_SYNC_QUEUED'
        | 'UNINSTALLED';
    };

interface OrderPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  cancelled_at?: string | null;
  note_attributes?: { name?: string; value?: unknown }[];
  line_items?: { variant_id?: number | string | null; quantity?: number }[];
}

const PRODUCT_TOPICS = ['products/create', 'products/update', 'products/delete'];

/** The webhook's order payload in the shape the order path takes; null without an order id. */
function orderInput(order: OrderPayload): ShopifyOrderInput | null {
  const orderId = order.admin_graphql_api_id ?? (order.id !== undefined ? `gid://shopify/Order/${order.id}` : null);
  if (!orderId) return null;
  const attributes: Record<string, string> = {};
  for (const a of order.note_attributes ?? []) {
    if (typeof a?.name === 'string' && typeof a.value === 'string' && !(a.name in attributes))
      attributes[a.name] = a.value;
  }
  const variantIds = (order.line_items ?? [])
    .map((l) => (l.variant_id === null || l.variant_id === undefined ? null : String(l.variant_id)))
    .filter((id): id is string => !!id)
    .map((id) => `gid://shopify/ProductVariant/${id}`);
  return { orderId, attributes, variantIds };
}

/**
 * POST /api/webhooks/shopify (L2-Shopify; docs/06 §8, §8.1). The raw body's HMAC is checked
 * first (401, nothing processed); the brand comes from the shop domain; each event is
 * processed once (receipt per event id + topic + brand). orders/create goes through the
 * one order path (ShopifyOrderService → OrderService.recordOrder) with the qs_ref cart
 * attribute — an invalid ref is recorded unattributed. orders/cancelled records the
 * cancellation (and the order, if its create was missed). products/* queue a catalogue
 * sync in the background. app/uninstalled deletes the stored token.
 */
export class ShopifyWebhookService {
  constructor(
    private readonly deps: {
      apiSecret: string;
      store: ShopifyConnectionStore;
      receipts: WebhookReceiptRepository;
      orders: Pick<ShopifyOrderService, 'record' | 'cancel'>;
      /** products/* → a background catalogue sync (ShopifyCatalogRefresh.request). */
      catalogChanged?: (brandId: string) => void;
      auth: Pick<ShopifyAuthService, 'removeConnection'>;
      audit: AuditRepository;
      now?: () => Date;
    },
  ) {}

  async handle(raw: Buffer, h: WebhookHeaders): Promise<WebhookResult> {
    if (!verifyWebhookHmac(raw, h.hmac, this.deps.apiSecret)) return { status: 401, outcome: 'INVALID_HMAC' };
    const shop = normalizeShopDomain(h.shopDomain);
    const brandId = shop ? await this.deps.store.brandForShop(shop) : null;
    if (!brandId) return { status: 200, outcome: 'UNKNOWN_SHOP' };
    const topic = (h.topic ?? '').toLowerCase();
    const eventId = h.eventId || h.webhookId || createHash('sha256').update(raw).digest('hex');
    const key = `shopify:${brandId}:${topic}:${eventId}`;
    const now = (this.deps.now ?? (() => new Date()))();
    const begun = await this.deps.receipts.begin(
      key,
      { brandId, provider: 'SHOPIFY', eventType: topic, externalEventId: eventId },
      now,
    );
    if (begun.state === 'DUPLICATE') return { status: 200, outcome: 'DUPLICATE' };

    try {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        payload = null;
      }
      let outcome: WebhookResult['outcome'] = 'IGNORED';
      const order = payload && typeof payload === 'object' ? orderInput(payload as OrderPayload) : null;
      if (topic === 'orders/create' && order) {
        await this.deps.orders.record(brandId, order);
        outcome = 'ORDER_RECORDED';
      } else if (topic === 'orders/cancelled' && order) {
        await this.deps.orders.record(brandId, order); // in case its orders/create never arrived
        await this.deps.orders.cancel(brandId, order.orderId, (payload as OrderPayload).cancelled_at ?? null);
        outcome = 'ORDER_CANCELLED';
      } else if (PRODUCT_TOPICS.includes(topic) && this.deps.catalogChanged) {
        this.deps.catalogChanged(brandId);
        outcome = 'CATALOG_SYNC_QUEUED';
      } else if (topic === 'app/uninstalled') {
        await this.deps.auth.removeConnection(brandId);
        await this.deps.audit.recordBrandEvent({
          brandId,
          actorType: 'SYSTEM',
          actorId: 'shopify-webhook',
          action: 'SHOPIFY_UNINSTALLED',
          targetType: 'CONNECTION',
          targetId: SHOPIFY_CONNECTION_ID,
          result: 'SUCCESS',
          reasonCode: null,
        });
        outcome = 'UNINSTALLED';
      }
      await this.deps.receipts.complete(key, { outcome });
      return { status: 200, outcome } as WebhookResult;
    } catch (err) {
      await this.deps.receipts.fail(key); // Shopify retries; the next delivery processes it
      throw err;
    }
  }
}
