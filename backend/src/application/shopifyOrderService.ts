import { AppError } from '../lib/errors.js';
import type { WebhookReceiptRepository } from '../ports/conversationRepositories.js';
import type { AuditRepository, ProductRepository } from '../ports/repositories.js';
import { ShopifyApiError } from '../ports/shopify.js';
import { SHOPIFY_CONNECTION_ID, type SyncActor } from './commerceSyncService.js';
import type { OrderService } from './orderService.js';
import { reconnectRequired, type CommerceProviderResolver } from './shopifyConnections.js';
import { shopifyNotConfigured } from './shopifyAuthService.js';

/** How far back the order check looks (Shopify's read_orders scope covers the last 60 days). */
export const ORDER_CHECK_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** A Shopify order as both paths see it: the orders/create webhook and the order check. */
export interface ShopifyOrderInput {
  /** gid://shopify/Order/… */
  orderId: string;
  /** The order's cart / note attributes, e.g. { qs_ref: "…" }. */
  attributes: Record<string, string>;
  /** gid://shopify/ProductVariant/… of each line item. */
  variantIds: string[];
}

export interface OrderCheckResult {
  /** Orders Shopify returned for the lookback window. */
  checked: number;
  /** Orders the webhooks had missed, recorded now. */
  recorded: number;
  /** Cancellations recorded now. */
  cancelled: number;
}

/**
 * Shopify orders → OrderService, the single order path (docs/06 §8.1). Each order is
 * recorded once per brand, whichever path sees it first: a receipt keyed by the order id
 * makes the orders/create webhook and the order check idempotent against each other.
 * The order check (Sync products, or POST /api/integrations/shopify/orders/sync) asks
 * Shopify for the last 7 days of orders and records what the webhooks missed — the backend
 * or the tunnel was down, a delivery was lost — and every cancellation.
 */
export class ShopifyOrderService {
  constructor(
    private readonly deps: {
      receipts: WebhookReceiptRepository;
      orders: Pick<OrderService, 'recordOrder' | 'cancelOrder'>;
      products: ProductRepository;
      resolver: Pick<CommerceProviderResolver, 'mode' | 'forBrand' | 'onUnauthorized'>;
      audit: AuditRepository;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Records the order once; DUPLICATE when the webhook or an earlier check already did. */
  async record(brandId: string, order: ShopifyOrderInput): Promise<'RECORDED' | 'DUPLICATE'> {
    const key = `shopify:${brandId}:order:${order.orderId}`;
    const begun = await this.deps.receipts.begin(
      key,
      { brandId, provider: 'SHOPIFY', eventType: 'orders/record', externalEventId: order.orderId },
      this.now(),
    );
    if (begun.state === 'DUPLICATE') return 'DUPLICATE';
    try {
      const numeric = order.orderId.split('/').pop();
      const attributionRef = clean(order.attributes.qs_ref);
      const webSessionId = clean(order.attributes.qs_ws) ?? `shopify_order_${numeric}`;
      const known = new Map(
        (await this.deps.products.listVariants(brandId)).map((v) => [v.shopifyVariantId, v.variantId] as const),
      );
      const variantIds = [...new Set(order.variantIds.map((id) => known.get(id) ?? null))];
      // One call per line-item variant; ORDER_CREATED is idempotent per order, outcomes first-purchase-wins.
      for (const variantId of variantIds.length ? variantIds : [null]) {
        await this.deps.orders.recordOrder({
          brandId,
          webSessionId,
          externalOrderId: order.orderId,
          variantId,
          source: 'SHOPIFY',
          attributionRef,
        });
      }
      await this.deps.receipts.complete(key, { outcome: 'ORDER_RECORDED' });
      return 'RECORDED';
    } catch (err) {
      await this.deps.receipts.fail(key); // the next delivery or check records it
      throw err;
    }
  }

  /** The order was cancelled in Shopify: true when this is the first time Qwikspot hears of it. */
  async cancel(brandId: string, orderId: string, cancelledAt: string | null): Promise<boolean> {
    const result = await this.deps.orders.cancelOrder({
      brandId,
      externalOrderId: orderId,
      source: 'SHOPIFY',
      at: cancelledAt,
    });
    return result.newlyCancelled;
  }

  /** The order check: the last 7 days of the connected store's orders, missed ones and cancellations recorded. */
  async check(brandId: string, actor: SyncActor): Promise<OrderCheckResult> {
    if (this.deps.resolver.mode !== 'shopify') throw shopifyNotConfigured();
    const provider = await this.deps.resolver.forBrand(brandId); // 409 SHOPIFY_NOT_CONNECTED
    const since = new Date(this.now().getTime() - ORDER_CHECK_LOOKBACK_MS).toISOString();
    let orders;
    try {
      orders = await provider.getOrders({ createdAfter: since });
    } catch (err) {
      if (err instanceof AppError) throw err; // e.g. reconnect required (already recorded)
      if (err instanceof ShopifyApiError && err.kind === 'UNAUTHORIZED') {
        await this.deps.resolver.onUnauthorized(brandId);
        throw reconnectRequired();
      }
      throw new AppError(502, 'SHOPIFY_ORDERS_FAILED', 'Shopify orders could not be checked. Try again.', true);
    }

    const result: OrderCheckResult = { checked: orders.length, recorded: 0, cancelled: 0 };
    for (const o of orders) {
      const recorded = await this.record(brandId, {
        orderId: o.externalOrderId,
        attributes: o.attributes,
        variantIds: o.lines.map((l) => l.externalVariantId),
      });
      if (recorded === 'RECORDED') result.recorded++;
      if (o.cancelledAt && (await this.cancel(brandId, o.externalOrderId, o.cancelledAt))) result.cancelled++;
    }
    await this.deps.audit.recordBrandEvent({
      brandId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'SHOPIFY_ORDERS_CHECKED',
      targetType: 'CONNECTION',
      targetId: SHOPIFY_CONNECTION_ID,
      result: 'SUCCESS',
      reasonCode: null,
    });
    return result;
  }
}

const clean = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
