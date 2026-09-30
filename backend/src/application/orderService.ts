import type { EventRecorder } from './eventRecorder.js';
import type { FollowUpService } from './followUpService.js';
import { intentIdFor } from './intentService.js';

/**
 * The single order-recording path (docs/00 §11.8 Change 11, D4). A completed purchase is
 * never a public browser event: locally the demo storefront's "Place order" calls this
 * through a local-only endpoint; in L2 the verified Shopify orders webhook calls the same
 * function. It writes ORDER_CREATED and marks the session's open intent CONVERTED, which
 * suppresses any pending follow-up (ALREADY_CONVERTED).
 */
export class OrderService {
  constructor(private readonly deps: { events: EventRecorder; followUps: FollowUpService; now?: () => Date }) {}

  async recordOrder(input: {
    brandId: string;
    webSessionId: string;
    externalOrderId: string;
    variantId: string | null;
    source: 'WEBSITE' | 'SHOPIFY';
  }): Promise<{ intentConverted: boolean }> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    const intentId = intentIdFor(input.brandId, input.webSessionId);
    const converted = await this.deps.followUps.markConverted(input.brandId, intentId);
    await this.deps.events.record({
      brandId: input.brandId,
      eventType: 'ORDER_CREATED',
      source: input.source,
      customerId: converted?.customerId ?? null,
      webSessionId: input.webSessionId,
      entityReference: input.externalOrderId,
      payload: { variant_id: input.variantId, intent_id: converted ? intentId : null },
      idempotencyKey: `ORDER_CREATED:${input.externalOrderId}`,
      at,
    });
    return { intentConverted: !!converted };
  }
}
