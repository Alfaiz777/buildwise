import type { AttributionService } from './attributionService.js';
import type { EventRecorder } from './eventRecorder.js';
import type { FollowUpService } from './followUpService.js';
import { intentIdFor } from './intentService.js';
import type { OutcomeService } from './outcomeService.js';
import type { IntentRepository } from '../ports/conversationRepositories.js';

/**
 * The single order-recording path (docs/00 §11.8 Change 11, D4; Change 13, F6). A completed
 * purchase is never a public browser event: locally the demo storefront's "Place order"
 * calls this through a local-only endpoint; in L2 the verified Shopify orders webhook calls
 * the same function with the `qs_ref` cart attribute. It writes ORDER_CREATED, marks the
 * session's open intent CONVERTED, and — when the order links to an engaged journey (a valid
 * `qs_ref`, or the session's engaged intent) — records the journey's Outcome. The ref only
 * links; the order is the evidence. An invalid ref never fails the order.
 */
export class OrderService {
  constructor(
    private readonly deps: {
      events: EventRecorder;
      followUps: FollowUpService;
      now?: () => Date;
      /** M6 (optional so M4 wiring keeps working): attribution and outcomes. */
      attribution?: AttributionService;
      outcomes?: OutcomeService;
      intents?: IntentRepository;
    },
  ) {}

  async recordOrder(input: {
    brandId: string;
    webSessionId: string;
    externalOrderId: string;
    variantId: string | null;
    source: 'WEBSITE' | 'SHOPIFY';
    /** The `qs_ref` the customer arrived with (null when none). */
    attributionRef?: string | null;
  }): Promise<{ intentConverted: boolean; attributed: boolean; journeyKey: string | null; outcomeRecorded: boolean }> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    const intentId = intentIdFor(input.brandId, input.webSessionId);
    const converted = await this.deps.followUps.markConverted(input.brandId, intentId);

    const link = this.deps.attribution
      ? await this.deps.attribution.resolve(input.brandId, input.attributionRef)
      : null;
    let journeyKey: string | null = null;
    let conversationId: string | null = null;
    if (link) {
      journeyKey = link.intentId ? `int:${link.intentId}` : link.conversationId ? `conv:${link.conversationId}` : null;
      conversationId = link.conversationId;
    } else if (this.deps.outcomes && this.deps.intents) {
      journeyKey = await this.deps.outcomes.engagedIntentJourney(
        input.brandId,
        await this.deps.intents.get(input.brandId, intentId),
      );
    }

    await this.deps.events.record({
      brandId: input.brandId,
      eventType: 'ORDER_CREATED',
      source: input.source,
      customerId: converted?.customerId ?? null,
      webSessionId: input.webSessionId,
      entityReference: input.externalOrderId,
      payload: {
        variant_id: input.variantId,
        intent_id: converted ? intentId : null,
        journey_key: journeyKey,
        attributed_by: link ? 'QS_REF' : journeyKey ? 'SESSION' : null,
      },
      idempotencyKey: `ORDER_CREATED:${input.externalOrderId}`,
      at,
    });

    await this.deps.events.audit(input.brandId, {
      action: 'ORDER_RECORDED',
      targetType: 'ORDER',
      targetId: input.externalOrderId,
      reasonCode: link ? 'ATTRIBUTED_QS_REF' : journeyKey ? 'ATTRIBUTED_SESSION' : 'UNATTRIBUTED',
      actor: { type: 'SYSTEM', id: input.source === 'SHOPIFY' ? 'shopify-webhook' : 'demo-storefront' },
    });

    let outcomeRecorded = false;
    if (journeyKey && this.deps.outcomes) {
      outcomeRecorded = !!(await this.deps.outcomes.recordFromOrder({
        brandId: input.brandId,
        journeyKey,
        conversationId,
        orderReference: input.externalOrderId,
        variantId: input.variantId,
        at,
      }));
    }
    return { intentConverted: !!converted, attributed: !!link, journeyKey, outcomeRecorded };
  }

  /**
   * A cancelled order: ORDER_CANCELLED once per order, and the Outcome it produced (if any)
   * no longer counts as a purchase. Replays are no-ops.
   */
  async cancelOrder(input: {
    brandId: string;
    externalOrderId: string;
    source: 'WEBSITE' | 'SHOPIFY';
    /** ISO-8601; when the order was cancelled (default now). */
    at?: string | null;
  }): Promise<{ newlyCancelled: boolean; outcomesCancelled: number }> {
    const at = input.at ?? (this.deps.now ?? (() => new Date()))().toISOString();
    const newlyCancelled = await this.deps.events.record({
      brandId: input.brandId,
      eventType: 'ORDER_CANCELLED',
      source: input.source,
      entityReference: input.externalOrderId,
      payload: {},
      idempotencyKey: `ORDER_CANCELLED:${input.externalOrderId}`,
      at,
    });
    const outcomesCancelled = this.deps.outcomes
      ? await this.deps.outcomes.cancelForOrder(input.brandId, input.externalOrderId, at)
      : 0;
    if (newlyCancelled) {
      await this.deps.events.audit(input.brandId, {
        action: 'ORDER_CANCELLED',
        targetType: 'ORDER',
        targetId: input.externalOrderId,
        reasonCode: outcomesCancelled ? 'OUTCOME_CANCELLED' : 'NO_OUTCOME',
        actor: { type: 'SYSTEM', id: input.source === 'SHOPIFY' ? 'shopify-webhook' : 'demo-storefront' },
      });
    }
    return { newlyCancelled, outcomesCancelled };
  }
}
