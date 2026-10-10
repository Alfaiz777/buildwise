/** In-memory InsightsReader over the test world's repositories (same contract as Firestore; no history flag). */
import type { InsightRows } from '../src/domain/insights.js';
import type { InsightsQuery, InsightsReader } from '../src/ports/insights.js';
import type {
  MemoryConversations,
  MemoryEvents,
  MemoryIntents,
  MemoryOutcomes,
  MemoryRecommendations,
} from './memoryConversation.js';
import type { MemoryReservations } from './memoryReservations.js';

export class MemoryInsightsReader implements InsightsReader {
  constructor(
    private readonly src: {
      intents: MemoryIntents;
      conversations: MemoryConversations;
      recommendations: MemoryRecommendations;
      events: MemoryEvents;
      reservations: MemoryReservations;
      outcomes: MemoryOutcomes;
    },
  ) {}

  async read(brandId: string, q: InsightsQuery): Promise<{ rows: InsightRows; historyRecords: number }> {
    const inRange = (iso: string | null | undefined) => !!iso && iso >= q.fromIso && iso <= q.toIso;
    const rows: InsightRows = {
      intents: this.src.intents.intents
        .filter((i) => i.brandId === brandId && inRange(i.detectedAt))
        .map((i) => ({ intentId: i.intentId, detectedAt: i.detectedAt, followUpSentAt: i.followUp?.sentAt ?? null })),
      conversations: this.src.conversations.conversations
        .filter((c) => c.brandId === brandId && inRange(c.startedAt))
        .map((c) => ({ conversationId: c.conversationId, startedAt: c.startedAt })),
      recommendations: this.src.recommendations.recommendations
        .filter((r) => r.brandId === brandId && inRange(r.proposedAt))
        .map((r) => ({ recommendationId: r.recommendationId, action: r.action, proposedAt: r.proposedAt })),
      lookups: this.src.events.events
        .filter(
          (e) =>
            e.brandId === brandId &&
            e.eventType === 'STORE_RECOMMENDATION' &&
            inRange(e.timestamp) &&
            ['PROPOSED', 'UNMET_DEMAND'].includes(String(e.payload.kind)),
        )
        .map((e) => {
          const p = e.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          const area = p.area as { value?: string } | undefined;
          return {
            eventId: e.eventId,
            timestamp: e.timestamp,
            kind: p.kind,
            variantId: p.variant_id ?? null,
            sku: p.sku ?? null,
            area: area?.value ?? null,
            excluded: ((p.excluded ?? []) as { store_id: string; reason: string }[]).map((x) => ({
              storeId: x.store_id,
              reason: x.reason,
            })),
            nearestStoreId: p.nearest_store_id ?? null,
            nearestReason: p.nearest_reason ?? null,
            timezone: p.timezone ?? null,
          };
        }),
      reservations: this.src.reservations.reservations
        .filter((r) => r.brandId === brandId && inRange(r.createdAt))
        .map((r) => ({
          reservationId: r.reservationId,
          storeId: r.storeId,
          variantId: r.variantId,
          status: r.status,
          createdAt: r.createdAt,
          cancelledBy: r.cancelledBy,
          cancelReason: r.cancelReason,
        })),
      outcomes: this.src.outcomes.outcomes
        .filter((o) => o.brandId === brandId && inRange(o.timestamp) && !o.cancelledAt)
        .map((o) => ({
          outcomeId: o.outcomeId,
          purchaseType: o.purchaseType,
          aiRecommendationId: o.aiRecommendationId,
          timestamp: o.timestamp,
          value: o.value,
          currency: o.currency,
        })),
    };
    return { rows, historyRecords: 0 };
  }
}
