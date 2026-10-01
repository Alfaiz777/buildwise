/**
 * Outcomes and attribution references (docs/04 §16, docs/00 §11.8 Change 13, F5–F6).
 * Outcomes are written only by deterministic backend code from verified evidence.
 */
import type { PurchaseType } from '../domain/outcomeRules.js';

export interface OutcomeRecord {
  outcomeId: string;
  brandId: string;
  customerId: string | null;
  journeyKey: string;
  sourceIntentId: string | null;
  conversationId: string | null;
  aiRecommendationId: string | null;
  purchaseType: PurchaseType;
  channel: string | null;
  storeId: string | null;
  reservationId: string | null;
  orderReference: string | null;
  variantId: string | null;
  value: number;
  currency: string | null;
  evidence: 'RESERVATION_COMPLETED' | 'ORDER' | 'WINDOW_CLOSED';
  timestamp: string;
}

export interface OutcomeRepository {
  /** Create-if-absent by outcome ID: false when the journey already has its Outcome (first wins). */
  createIfAbsent(outcome: OutcomeRecord): Promise<boolean>;
  get(brandId: string, outcomeId: string): Promise<OutcomeRecord | null>;
}

/** brands/{b}/attributionRefs/{sha256(ref)} — links an order to a journey; no PII. */
export interface AttributionRefRecord {
  refHash: string;
  brandId: string;
  intentId: string | null;
  conversationId: string | null;
  recommendationId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AttributionRefRepository {
  create(ref: AttributionRefRecord): Promise<void>;
  get(brandId: string, refHash: string): Promise<AttributionRefRecord | null>;
}
