/**
 * Reservation persistence (docs/04_DATA_MODEL.md §15, docs/03_TECH_ARCHITECTURE.md §15).
 * Every method that changes status or stock runs as ONE transaction in the adapter; the
 * rules themselves are pure domain functions passed in (domain/reservationStatus.ts).
 */
import type {
  TransitionDecision,
  TransitionRejection,
  ReservationPolicy,
  ReservationRejection,
  ReservableState,
  ReservationStatus,
} from '../domain/reservationStatus.js';

export interface ReservationRecord {
  reservationId: string;
  brandId: string;
  retailerId: string | null;
  customerId: string;
  storeId: string;
  variantId: string;
  sku: string;
  canonicalSku: string;
  quantity: number;
  status: ReservationStatus;
  idempotencyKey: string;
  aiRecommendationId: string | null;
  pickupCode: string;
  customerEta: string | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  customerArrivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: 'CUSTOMER' | 'RETAILER' | 'SYSTEM' | null;
  cancelReason: string | null;
  /** M6: internal note for a refusal with reason OTHER (never shown to the customer). */
  cancelNote: string | null;
  /** M6: wrong pickup codes entered at completion (locked from 5). */
  pickupCodeAttempts: number;
  /** M6: what the customer was told about the last store update. */
  lastNotification: ReservationNotification | null;
  /** Generated demo history (`demo_history: true` on the document; Change 16, UI-3). Read-only. */
  demoHistory?: boolean;
}

export interface ReservationNotification {
  status: 'SENT' | 'NOT_SENT_OPTED_OUT' | 'NOT_SENT_NO_CONVERSATION';
  event: string;
  messageKind: 'SESSION' | 'TEMPLATE' | null;
  at: string;
}

export interface CreateReservationRequest {
  reservationId: string;
  brandId: string;
  customerId: string;
  storeId: string;
  variantId: string;
  sku: string;
  canonicalSku: string;
  quantity: number;
  idempotencyKey: string;
  aiRecommendationId: string | null;
  customerEta: string | null;
  now: string;
}

export interface CreateReservationRules {
  /** reads brand.settings inside the transaction */
  policyOf: (settings: Record<string, unknown>) => ReservationPolicy;
  check: (state: ReservableState) => ReservationRejection | null;
  pickupCode: () => string;
  attempts: number;
}

export type CreateReservationResult =
  | { status: 'CREATED' | 'REPLAYED'; reservation: ReservationRecord }
  | { status: 'REJECTED'; reason: ReservationRejection | 'PICKUP_CODE_UNAVAILABLE' };

export type TransitionResult =
  | {
      status: 'OK';
      reservation: ReservationRecord;
      before: ReservationRecord;
      /** The store's stock row after the change (null when the store has no row for the SKU). */
      inventory: { quantity: number; reservedQuantity: number } | null;
    }
  | { status: 'NOT_FOUND' }
  | { status: 'REJECTED'; reason: TransitionRejection; reservation: ReservationRecord };

export interface ReservationRepository {
  /** docs/03 §15 in one transaction: replay → store → stock → policy → pickup code → write + reserve. */
  create(request: CreateReservationRequest, rules: CreateReservationRules): Promise<CreateReservationResult>;
  get(brandId: string, reservationId: string): Promise<ReservationRecord | null>;
  /**
   * In ONE transaction: re-read the reservation, ask `decide` (a pure domain rule) what to
   * do, then either write the new status + timestamps and apply the inventory plan
   * (domain/reservationStatus.applyInventoryPlan), or write only the rejection's
   * pickup_code_attempts. Nothing else changes on a rejection.
   */
  transition(
    brandId: string,
    reservationId: string,
    decide: (current: ReservationRecord) => TransitionDecision,
  ): Promise<TransitionResult>;
  setNotification(brandId: string, reservationId: string, notification: ReservationNotification): Promise<void>;
  /** Newest first. */
  list(
    brandId: string,
    filter: { storeId?: string; customerId?: string; status?: ReservationStatus; limit: number },
  ): Promise<ReservationRecord[]>;
  /** Reservations in `statuses` with expires_at ≤ nowIso. */
  listExpired(brandId: string, statuses: readonly ReservationStatus[], nowIso: string): Promise<ReservationRecord[]>;
}
