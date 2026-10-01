/**
 * Reservation persistence (docs/04_DATA_MODEL.md §15, docs/03_TECH_ARCHITECTURE.md §15).
 * Every method that changes status or stock runs as ONE transaction in the adapter; the
 * rules themselves are pure domain functions passed in (domain/reservationStatus.ts).
 */
import type {
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
  | { status: 'OK'; reservation: ReservationRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'INVALID_TRANSITION'; reservation: ReservationRecord };

export interface ReservationRepository {
  /** docs/03 §15 in one transaction: replay → store → stock → policy → pickup code → write + reserve. */
  create(request: CreateReservationRequest, rules: CreateReservationRules): Promise<CreateReservationResult>;
  get(brandId: string, reservationId: string): Promise<ReservationRecord | null>;
  /**
   * In one transaction: re-read the reservation, require `allowed(from)`, apply the
   * inventory effect to reserved_quantity / quantity (never below 0), write the new status.
   */
  transition(
    brandId: string,
    reservationId: string,
    to: ReservationStatus,
    rules: {
      allowed: (from: ReservationStatus) => boolean;
      effect: (quantity: number) => { reserved: number; onHand: number };
      patch: Partial<Pick<ReservationRecord, 'cancelledAt' | 'cancelledBy' | 'cancelReason'>>;
    },
  ): Promise<TransitionResult>;
  /** Newest first. */
  list(
    brandId: string,
    filter: { storeId?: string; customerId?: string; status?: ReservationStatus; limit: number },
  ): Promise<ReservationRecord[]>;
  /** Reservations in `statuses` with expires_at ≤ nowIso. */
  listExpired(brandId: string, statuses: readonly ReservationStatus[], nowIso: string): Promise<ReservationRecord[]>;
}
