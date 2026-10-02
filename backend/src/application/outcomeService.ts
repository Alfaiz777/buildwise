import { ACTIVE_RESERVATION_STATUSES } from '../domain/reservationStatus.js';
import {
  attributionWindowMs,
  isJourneyClosed,
  journeyKeyFor,
  parseJourneyKey,
  purchaseTypeFor,
} from '../domain/outcomeRules.js';
import { hashedId } from '../lib/ids.js';
import type {
  ConversationRepository,
  IntentRecord,
  IntentRepository,
  RecommendationRecord,
  RecommendationRepository,
} from '../ports/conversationRepositories.js';
import type { OutcomeRecord, OutcomeRepository } from '../ports/outcomes.js';
import type { ReservationRecord, ReservationRepository } from '../ports/reservations.js';
import type { BrandRepository, ProductRepository } from '../ports/repositories.js';
import type { EventRecorder } from './eventRecorder.js';

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/**
 * OutcomeService (docs/04 §16, docs/00 §11.8 Change 13, F5). Deterministic backend code
 * only — never the AI, never the browser. One Outcome per engaged journey; the document ID
 * derives from the journey key and is created only if absent, so the first verified
 * purchase wins and replays are no-ops.
 */
export class OutcomeService {
  constructor(
    private readonly deps: {
      outcomes: OutcomeRepository;
      recommendations: RecommendationRepository;
      intents: IntentRepository;
      conversations: ConversationRepository;
      reservations: ReservationRepository;
      products: ProductRepository;
      brands: BrandRepository;
      events: EventRecorder;
      now: () => Date;
    },
  ) {}

  static idFor(brandId: string, journeyKey: string) {
    return hashedId('out', `${brandId}:${journeyKey}`, 24);
  }

  /** The journey's recommendations, oldest first (intent journey: all for the intent; conversation journey: those without an intent). */
  private async journeyRecommendations(brandId: string, journeyKey: string): Promise<RecommendationRecord[]> {
    const { intentId, conversationId } = parseJourneyKey(journeyKey);
    if (intentId) return this.deps.recommendations.listByIntent(brandId, intentId);
    if (!conversationId) return [];
    return (await this.deps.recommendations.listByConversation(brandId, conversationId)).filter((r) => !r.intentId);
  }

  private async price(brandId: string, variantId: string | null) {
    const v = variantId
      ? (await this.deps.products.listVariants(brandId)).find((x) => x.variantId === variantId)
      : undefined;
    return { price: v?.price ?? 0, currency: v?.currency ?? null };
  }

  private async write(o: OutcomeRecord): Promise<OutcomeRecord | null> {
    if (!(await this.deps.outcomes.createIfAbsent(o))) return null; // the journey already has its Outcome
    await this.deps.events.record({
      brandId: o.brandId,
      customerId: o.customerId,
      eventType: 'OUTCOME_RECORDED',
      source: 'QWIKSPOT',
      entityReference: o.outcomeId,
      payload: {
        purchase_type: o.purchaseType,
        journey_key: o.journeyKey,
        evidence: o.evidence,
        recommendation_id: o.aiRecommendationId,
        value: o.value,
      },
      idempotencyKey: `OUTCOME_RECORDED:${o.outcomeId}`,
      at: o.timestamp,
    });
    await this.deps.events.audit(o.brandId, {
      action: 'OUTCOME_RECORDED',
      targetType: 'OUTCOME',
      targetId: o.outcomeId,
      reasonCode: `${o.purchaseType}:${o.evidence}`,
    });
    return o;
  }

  private async base(
    brandId: string,
    journeyKey: string,
    intent: IntentRecord | null,
    fallbackConversationId: string | null,
  ) {
    const recs = await this.journeyRecommendations(brandId, journeyKey);
    const last = recs.at(-1) ?? null;
    const conversationId = last?.conversationId ?? fallbackConversationId;
    const conversation = conversationId ? await this.deps.conversations.get(brandId, conversationId) : null;
    return {
      recs,
      fields: {
        outcomeId: OutcomeService.idFor(brandId, journeyKey),
        brandId,
        customerId: conversation?.customerId ?? intent?.customerId ?? last?.customerId ?? null,
        journeyKey,
        sourceIntentId: intent?.intentId ?? null,
        conversationId,
        aiRecommendationId: last?.recommendationId ?? null,
        channel: conversation?.channel ?? null,
      },
    };
  }

  /** Verified evidence: a reservation COMPLETED at the store → OFFLINE (or ALTERNATIVE for another variant). */
  async recordFromReservation(r: ReservationRecord): Promise<OutcomeRecord | null> {
    if (r.status !== 'COMPLETED' || !r.aiRecommendationId) return null;
    const rec = await this.deps.recommendations.get(r.brandId, r.aiRecommendationId);
    if (!rec) return null;
    const journeyKey = journeyKeyFor(rec);
    const intent = rec.intentId ? await this.deps.intents.get(r.brandId, rec.intentId) : null;
    const { fields } = await this.base(r.brandId, journeyKey, intent, rec.conversationId);
    const { price, currency } = await this.price(r.brandId, r.variantId);
    return this.write({
      ...fields,
      purchaseType: purchaseTypeFor('STORE', intent?.variantId ?? null, r.variantId),
      storeId: r.storeId,
      reservationId: r.reservationId,
      orderReference: null,
      variantId: r.variantId,
      value: price * r.quantity,
      currency,
      evidence: 'RESERVATION_COMPLETED',
      timestamp: r.completedAt ?? this.deps.now().toISOString(),
    });
  }

  /** Verified evidence: an order linked to the journey (qs_ref or the engaged session intent) → ONLINE (or ALTERNATIVE). */
  async recordFromOrder(input: {
    brandId: string;
    journeyKey: string;
    conversationId: string | null;
    orderReference: string;
    variantId: string | null;
    at: string;
  }): Promise<OutcomeRecord | null> {
    const { intentId } = parseJourneyKey(input.journeyKey);
    const intent = intentId ? await this.deps.intents.get(input.brandId, intentId) : null;
    const { recs, fields } = await this.base(input.brandId, input.journeyKey, intent, input.conversationId);
    const journeyVariant = intent?.variantId ?? recs.at(-1)?.targetVariantId ?? null;
    const { price, currency } = await this.price(input.brandId, input.variantId);
    return this.write({
      ...fields,
      purchaseType: purchaseTypeFor('ONLINE', journeyVariant, input.variantId),
      storeId: null,
      reservationId: null,
      orderReference: input.orderReference,
      variantId: input.variantId,
      value: price,
      currency,
      evidence: 'ORDER',
      timestamp: input.at,
    });
  }

  /** Pipeline step 11: re-checks stored evidence for this customer's journeys (idempotent; never from AI output). */
  async evaluateCustomer(brandId: string, customerId: string): Promise<void> {
    const completed = await this.deps.reservations.list(brandId, { customerId, status: 'COMPLETED', limit: 50 });
    for (const r of completed) {
      if (!r.aiRecommendationId) continue;
      const rec = await this.deps.recommendations.get(brandId, r.aiRecommendationId);
      if (rec && !(await this.deps.outcomes.get(brandId, OutcomeService.idFor(brandId, journeyKeyFor(rec))))) {
        await this.recordFromReservation(r);
      }
    }
  }

  /**
   * The process-due sweep: engaged journeys whose attribution window has closed with no
   * verified purchase and no active reservation → NONE. Never at the moment a hold expires.
   */
  async closeExpiredJourneys(brandId: string): Promise<number> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) return 0;
    const now = this.deps.now();
    const windowMs = attributionWindowMs(brand.settings);
    const to = new Date(now.getTime() - windowMs).toISOString();
    const from = new Date(now.getTime() - windowMs - LOOKBACK_MS).toISOString();
    const keys = new Set<string>();
    for (const rec of await this.deps.recommendations.listProposedBetween(brandId, from, to))
      keys.add(journeyKeyFor(rec));
    for (const intent of await this.deps.intents.listFollowUpsSentBetween(brandId, from, to)) {
      keys.add(`int:${intent.intentId}`);
    }

    let closed = 0;
    for (const journeyKey of keys) {
      if (await this.deps.outcomes.get(brandId, OutcomeService.idFor(brandId, journeyKey))) continue;
      const { intentId } = parseJourneyKey(journeyKey);
      const intent = intentId ? await this.deps.intents.get(brandId, intentId) : null;
      const { recs, fields } = await this.base(brandId, journeyKey, intent, null);
      const recIds = new Set(recs.map((r) => r.recommendationId));
      const journeyReservations = fields.customerId
        ? (await this.deps.reservations.list(brandId, { customerId: fields.customerId, limit: 200 })).filter(
            (r) => r.aiRecommendationId && recIds.has(r.aiRecommendationId),
          )
        : [];
      // The window counts from the journey's last activity — its last recommendation or
      // proactive message, or the moment its last hold ended — so a NONE is never written
      // at the moment a hold expires or is cancelled (the customer may still buy online).
      const lastActivityAt = [
        recs.at(-1)?.proposedAt,
        intent?.followUp?.sentAt,
        ...journeyReservations.map((r) => (r.status === 'EXPIRED' ? r.expiresAt : r.cancelledAt)),
      ]
        .filter((x): x is string => !!x)
        .sort()
        .at(-1);
      if (!lastActivityAt) continue;
      const hasActiveReservation = journeyReservations.some((r) => ACTIVE_RESERVATION_STATUSES.includes(r.status));
      if (!isJourneyClosed({ lastActivityAt, windowMs, now, hasActiveReservation })) continue;
      // A completed reservation not yet recorded is evidence, never NONE.
      const completed = journeyReservations.find((r) => r.status === 'COMPLETED');
      if (completed) {
        await this.recordFromReservation(completed);
        continue;
      }
      const written = await this.write({
        ...fields,
        purchaseType: 'NONE',
        storeId: null,
        reservationId: null,
        orderReference: null,
        variantId: intent?.variantId ?? recs.at(-1)?.targetVariantId ?? null,
        value: 0,
        currency: null,
        evidence: 'WINDOW_CLOSED',
        timestamp: now.toISOString(),
      });
      if (written) closed++;
    }
    return closed;
  }

  /** An engaged session intent is a journey: the customer chatted (token or recommendations) or got a follow-up. */
  async engagedIntentJourney(brandId: string, intent: IntentRecord | null): Promise<string | null> {
    if (!intent || !intent.customerId) return null;
    if (intent.tokenConsumedAt || intent.followUp?.sentAt) return `int:${intent.intentId}`;
    const recs = await this.deps.recommendations.listByIntent(brandId, intent.intentId);
    return recs.length ? `int:${intent.intentId}` : null;
  }
}
