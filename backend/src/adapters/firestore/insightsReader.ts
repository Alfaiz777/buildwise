import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { InsightRows } from '../../domain/insights.js';
import type { InsightsQuery, InsightsReader } from '../../ports/insights.js';

/**
 * InsightsReader over Firestore: range queries on the ISO-8601 timestamp fields of each
 * brand collection. Documents written by the synthetic demo history carry
 * `demo_history: true` and are left out when the caller excludes them.
 */
export class FirestoreInsightsReader implements InsightsReader {
  constructor(private readonly db: Firestore) {}

  async read(brandId: string, q: InsightsQuery): Promise<{ rows: InsightRows; historyRecords: number }> {
    const brand = this.db.collection('brands').doc(brandId);
    const range = (name: string, field: string) =>
      brand.collection(name).where(field, '>=', q.fromIso).where(field, '<=', q.toIso).get();
    const [intents, conversations, recommendations, lookups, reservations, outcomes] = await Promise.all([
      range('customerIntents', 'detected_at'),
      range('conversations', 'started_at'),
      range('aiRecommendations', 'proposed_at'),
      brand
        .collection('commerceEvents')
        .where('event_type', '==', 'STORE_RECOMMENDATION')
        .where('timestamp', '>=', q.fromIso)
        .where('timestamp', '<=', q.toIso)
        .get(),
      range('reservations', 'created_at'),
      range('outcomes', 'timestamp'),
    ]);
    let historyRecords = 0;
    const keep = (docs: QueryDocumentSnapshot[]) =>
      docs.filter((d) => {
        const history = d.get('demo_history') === true;
        if (history) historyRecords++;
        return q.includeHistory || !history;
      });

    const rows: InsightRows = {
      intents: keep(intents.docs).map((d) => ({
        intentId: d.id,
        detectedAt: d.get('detected_at'),
        followUpSentAt: d.get('follow_up')?.sent_at ?? null,
      })),
      conversations: keep(conversations.docs).map((d) => ({ conversationId: d.id, startedAt: d.get('started_at') })),
      recommendations: keep(recommendations.docs).map((d) => ({
        recommendationId: d.id,
        action: d.get('action'),
        proposedAt: d.get('proposed_at'),
      })),
      lookups: keep(lookups.docs)
        .filter((d) => ['PROPOSED', 'UNMET_DEMAND'].includes(d.get('payload')?.kind))
        .map((d) => {
          const p = d.get('payload') ?? {};
          return {
            eventId: d.id,
            timestamp: d.get('timestamp'),
            kind: p.kind,
            variantId: p.variant_id ?? null,
            sku: p.sku ?? null,
            area: p.area?.value ?? null,
            excluded: (p.excluded ?? []).map((x: { store_id: string; reason: string }) => ({
              storeId: x.store_id,
              reason: x.reason,
            })),
            nearestStoreId: p.nearest_store_id ?? null,
            nearestReason: p.nearest_reason ?? null,
            timezone: p.timezone ?? null,
          };
        }),
      reservations: keep(reservations.docs).map((d) => ({
        reservationId: d.id,
        storeId: d.get('store_id'),
        variantId: d.get('variant_id'),
        status: d.get('status'),
        createdAt: d.get('created_at'),
        cancelledBy: d.get('cancelled_by') ?? null,
        cancelReason: d.get('cancel_reason') ?? null,
      })),
      // A cancelled order's Outcome no longer counts as a purchase.
      outcomes: keep(outcomes.docs.filter((d) => !d.get('cancelled_at'))).map((d) => ({
        outcomeId: d.id,
        purchaseType: d.get('purchase_type'),
        aiRecommendationId: d.get('ai_recommendation_id') ?? null,
        timestamp: d.get('timestamp'),
        value: Number(d.get('value') ?? 0),
        currency: d.get('currency') ?? null,
      })),
    };
    return { rows, historyRecords };
  }
}
