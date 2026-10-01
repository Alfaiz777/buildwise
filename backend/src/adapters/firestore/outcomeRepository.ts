import type { Firestore } from 'firebase-admin/firestore';
import type {
  AttributionRefRecord,
  AttributionRefRepository,
  OutcomeRecord,
  OutcomeRepository,
} from '../../ports/outcomes.js';

/** brands/{b}/outcomes — one document per journey, created only if absent (first verified purchase wins). */
export class FirestoreOutcomeRepository implements OutcomeRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('outcomes');
  }

  async createIfAbsent(o: OutcomeRecord): Promise<boolean> {
    try {
      await this.col(o.brandId).doc(o.outcomeId).create({
        outcome_id: o.outcomeId,
        brand_id: o.brandId,
        customer_id: o.customerId,
        journey_key: o.journeyKey,
        source_intent_id: o.sourceIntentId,
        conversation_id: o.conversationId,
        ai_recommendation_id: o.aiRecommendationId,
        purchase_type: o.purchaseType,
        channel: o.channel,
        store_id: o.storeId,
        reservation_id: o.reservationId,
        order_reference: o.orderReference,
        variant_id: o.variantId,
        value: o.value,
        currency: o.currency,
        evidence: o.evidence,
        timestamp: o.timestamp,
      });
      return true;
    } catch (err) {
      if ((err as { code?: unknown }).code === 6) return false; // ALREADY_EXISTS: this journey already has its Outcome
      throw err;
    }
  }

  async get(brandId: string, outcomeId: string): Promise<OutcomeRecord | null> {
    const snap = await this.col(brandId).doc(outcomeId).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return {
      outcomeId: snap.id,
      brandId,
      customerId: d.customer_id ?? null,
      journeyKey: d.journey_key,
      sourceIntentId: d.source_intent_id ?? null,
      conversationId: d.conversation_id ?? null,
      aiRecommendationId: d.ai_recommendation_id ?? null,
      purchaseType: d.purchase_type,
      channel: d.channel ?? null,
      storeId: d.store_id ?? null,
      reservationId: d.reservation_id ?? null,
      orderReference: d.order_reference ?? null,
      variantId: d.variant_id ?? null,
      value: d.value ?? 0,
      currency: d.currency ?? null,
      evidence: d.evidence,
      timestamp: d.timestamp,
    };
  }
}

/** brands/{b}/attributionRefs/{sha256(ref)} — the raw ref is never stored. */
export class FirestoreAttributionRefRepository implements AttributionRefRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('attributionRefs');
  }

  async create(r: AttributionRefRecord) {
    await this.col(r.brandId).doc(r.refHash).create({
      brand_id: r.brandId,
      intent_id: r.intentId,
      conversation_id: r.conversationId,
      recommendation_id: r.recommendationId,
      created_at: r.createdAt,
      expires_at: r.expiresAt,
    });
  }

  async get(brandId: string, refHash: string): Promise<AttributionRefRecord | null> {
    const snap = await this.col(brandId).doc(refHash).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return {
      refHash: snap.id,
      brandId: d.brand_id,
      intentId: d.intent_id ?? null,
      conversationId: d.conversation_id ?? null,
      recommendationId: d.recommendation_id ?? null,
      createdAt: d.created_at,
      expiresAt: d.expires_at,
    };
  }
}
