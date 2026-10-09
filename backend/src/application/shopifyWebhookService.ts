import { createHash } from 'node:crypto';
import { normalizeShopDomain, verifyWebhookHmac } from '../domain/shopifyOAuth.js';
import type { WebhookReceiptRepository } from '../ports/conversationRepositories.js';
import type { AuditRepository, ProductRepository } from '../ports/repositories.js';
import type { ShopifyConnectionStore } from '../ports/shopify.js';
import { SHOPIFY_CONNECTION_ID } from './commerceSyncService.js';
import type { OrderService } from './orderService.js';
import type { ShopifyAuthService } from './shopifyAuthService.js';

export interface WebhookHeaders {
  hmac?: string;
  topic?: string;
  shopDomain?: string;
  eventId?: string;
  webhookId?: string;
}

export type WebhookResult =
  | { status: 401; outcome: 'INVALID_HMAC' }
  | { status: 200; outcome: 'UNKNOWN_SHOP' | 'DUPLICATE' | 'IGNORED' | 'ORDER_RECORDED' | 'UNINSTALLED' };

interface OrderPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  note_attributes?: { name?: string; value?: unknown }[];
  line_items?: { variant_id?: number | string | null; quantity?: number }[];
}

const attribute = (order: OrderPayload, name: string): string | null => {
  const hit = (order.note_attributes ?? []).find((a) => a?.name === name);
  return typeof hit?.value === 'string' && hit.value.trim() ? hit.value.trim().slice(0, 128) : null;
};

/**
 * POST /api/webhooks/shopify (L2-Shopify; docs/06 §8, §8.1). The raw body's HMAC is checked
 * first (401, nothing processed); the brand comes from the shop domain; each event is
 * processed once (receipt per event id + topic + brand). orders/create goes through the
 * one order path, OrderService.recordOrder, with the qs_ref cart attribute — an invalid
 * ref is recorded unattributed. app/uninstalled deletes the stored token.
 */
export class ShopifyWebhookService {
  constructor(
    private readonly deps: {
      apiSecret: string;
      store: ShopifyConnectionStore;
      receipts: WebhookReceiptRepository;
      orders: OrderService;
      products: ProductRepository;
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
      if (topic === 'orders/create' && payload && typeof payload === 'object') {
        await this.orderCreated(brandId, payload as OrderPayload);
        outcome = 'ORDER_RECORDED';
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

  private async orderCreated(brandId: string, order: OrderPayload) {
    const orderId = order.admin_graphql_api_id ?? (order.id !== undefined ? `gid://shopify/Order/${order.id}` : null);
    if (!orderId) return;
    const numeric = orderId.split('/').pop();
    const attributionRef = attribute(order, 'qs_ref');
    const webSessionId = attribute(order, 'qs_ws') ?? `shopify_order_${numeric}`;
    const known = new Map(
      (await this.deps.products.listVariants(brandId)).map((v) => [v.shopifyVariantId, v.variantId] as const),
    );
    const variantIds = [
      ...new Set(
        (order.line_items ?? [])
          .map((l) => (l.variant_id === null || l.variant_id === undefined ? null : String(l.variant_id)))
          .filter((id): id is string => !!id)
          .map((id) => known.get(`gid://shopify/ProductVariant/${id}`) ?? null),
      ),
    ];
    // One call per line-item variant; ORDER_CREATED is idempotent per order, outcomes first-purchase-wins.
    for (const variantId of variantIds.length ? variantIds : [null]) {
      await this.deps.orders.recordOrder({
        brandId,
        webSessionId,
        externalOrderId: orderId,
        variantId,
        source: 'SHOPIFY',
        attributionRef,
      });
    }
  }
}
