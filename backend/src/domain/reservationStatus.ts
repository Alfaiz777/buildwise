/**
 * Reservation lifecycle (docs/04_DATA_MODEL.md §15) and the rules checked inside the
 * reservation transaction (docs/03_TECH_ARCHITECTURE.md §15). Pure: the Firestore adapter
 * reads the documents in the transaction and asks these functions what to write.
 */
import { randomInt } from 'node:crypto';
import { availableQuantity } from './storeTruth.js';

export const RESERVATION_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'READY',
  'CUSTOMER_ARRIVED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Statuses that hold stock (and a pickup code). */
export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'PENDING',
  'CONFIRMED',
  'READY',
  'CUSTOMER_ARRIVED',
];
/** Statuses the expiry sweep may move to EXPIRED. */
export const EXPIRABLE_STATUSES: readonly ReservationStatus[] = ['PENDING', 'CONFIRMED', 'READY'];

const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['READY', 'CANCELLED', 'EXPIRED'],
  READY: ['CUSTOMER_ARRIVED', 'CANCELLED', 'EXPIRED'],
  CUSTOMER_ARRIVED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canTransition = (from: ReservationStatus, to: ReservationStatus) => TRANSITIONS[from].includes(to);

/** Inventory effect of moving to `to` (docs/04 §15). */
export function inventoryEffect(to: ReservationStatus, quantity: number): { reserved: number; onHand: number } {
  if (to === 'CANCELLED' || to === 'EXPIRED') return { reserved: -quantity, onHand: 0 };
  if (to === 'COMPLETED') return { reserved: -quantity, onHand: -quantity };
  return { reserved: 0, onHand: 0 };
}

export type ReservationRejection =
  'OUT_OF_STOCK' | 'STORE_INACTIVE' | 'RESERVATIONS_DISABLED' | 'QUANTITY_LIMIT_EXCEEDED' | 'UNKNOWN_VARIANT';

export interface ReservationPolicy {
  reservationsEnabled: boolean;
  holdMinutes: number;
  maxQuantityPerReservation: number;
}

const DEFAULT_POLICY: ReservationPolicy = {
  reservationsEnabled: false,
  holdMinutes: 120,
  maxQuantityPerReservation: 2,
};

/** brand.settings.reservation_policy with safe defaults (reservations off unless enabled). */
export function resolveReservationPolicy(settings: Record<string, unknown>): ReservationPolicy {
  const raw = settings.reservation_policy;
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown, fallback: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : fallback;
  return {
    reservationsEnabled: p.reservations_enabled === true,
    holdMinutes: int(p.hold_minutes, DEFAULT_POLICY.holdMinutes, 7 * 24 * 60),
    maxQuantityPerReservation: int(p.max_quantity_per_reservation, DEFAULT_POLICY.maxQuantityPerReservation, 100),
  };
}

export interface ReservableState {
  store: { storeStatus: string; reservationAvailable: boolean } | null;
  inventory: { quantity: number; reservedQuantity: number } | null;
  policy: ReservationPolicy;
  quantity: number;
}

/**
 * The creation checks of docs/03 §15 in order. Null = reservable. Evaluated INSIDE the
 * transaction on freshly read documents, so a lost race surfaces as OUT_OF_STOCK.
 */
export function checkReservable(state: ReservableState): ReservationRejection | null {
  if (!state.store || state.store.storeStatus !== 'ACTIVE') return 'STORE_INACTIVE';
  if (!state.store.reservationAvailable || !state.policy.reservationsEnabled) return 'RESERVATIONS_DISABLED';
  if (state.quantity < 1 || state.quantity > state.policy.maxQuantityPerReservation) return 'QUANTITY_LIMIT_EXCEEDED';
  if (!state.inventory) return 'OUT_OF_STOCK';
  const available = availableQuantity(state.inventory.quantity, state.inventory.reservedQuantity);
  return available >= state.quantity ? null : 'OUT_OF_STOCK';
}

export const PICKUP_CODE_PATTERN = /^\d{6}$/;
export const PICKUP_CODE_ATTEMPTS = 5;

/** Six random digits (leading zeros kept), shown by the customer at the store. */
export const generatePickupCode = (random: (max: number) => number = (max) => randomInt(max)) =>
  String(random(1_000_000)).padStart(6, '0');

/** "Customer •••• 4821": a masked reference for retail screens (docs/06 §14.4). */
export function maskCustomerRef(customerId: string): string {
  const digits = customerId.replace(/[^0-9a-f]/gi, '');
  return `Customer •••• ${digits.slice(-4).toUpperCase() || '0000'}`;
}

// ---------------------------------------------------------------- M6: store fulfilment (Change 13, F1–F3)

export const REFUSAL_REASONS = ['NOT_ACTUALLY_IN_STOCK', 'DAMAGED', 'STORE_CLOSING_EARLY', 'OTHER'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export const CANCEL_NOTE_MAX = 140;
export const PICKUP_CODE_MAX_ATTEMPTS = 5;

/** The statuses a RETAIL_ADMIN may move a reservation to (expiry is SYSTEM-only). */
export const RETAILER_TARGETS: readonly ReservationStatus[] = [
  'CONFIRMED',
  'READY',
  'CUSTOMER_ARRIVED',
  'COMPLETED',
  'CANCELLED',
];

/** The actions shown on a store's queue card for the current status. */
export function retailerActionsFor(status: ReservationStatus, pickupCodeLocked = false): ReservationStatus[] {
  return TRANSITIONS[status].filter((to) => RETAILER_TARGETS.includes(to) && !(to === 'COMPLETED' && pickupCodeLocked));
}

export type PickupCodeCheck = 'OK' | 'MISMATCH' | 'LOCKED';

/** Locked from the 5th wrong attempt; the comparison ignores spaces. */
export function checkPickupCode(stored: string, entered: string | null | undefined, attempts: number): PickupCodeCheck {
  if (attempts >= PICKUP_CODE_MAX_ATTEMPTS) return 'LOCKED';
  return (entered ?? '').replace(/\s/g, '') === stored ? 'OK' : 'MISMATCH';
}

export interface RetailerTransitionRequest {
  to: ReservationStatus;
  expectedCurrentStatus: ReservationStatus;
  cancelReason?: RefusalReason | null;
  cancelNote?: string | null;
  pickupCode?: string | null;
}

export type TransitionRejection =
  'STALE_STATUS' | 'INVALID_TRANSITION' | 'PICKUP_CODE_MISMATCH' | 'PICKUP_CODE_LOCKED' | 'REASON_REQUIRED';

export interface TransitionPlan {
  to: ReservationStatus;
  effect: { reserved: number; onHand: number };
  /** NOT_ACTUALLY_IN_STOCK: after the release, quantity is set to the remaining reserved quantity. */
  correctQuantityToReserved: boolean;
  patch: Record<string, string | number | null>;
}

export type TransitionDecision =
  | { kind: 'APPLY'; plan: TransitionPlan }
  | { kind: 'REJECT'; reason: TransitionRejection; pickupCodeAttempts?: number };

const TIMESTAMP_FIELD: Partial<Record<ReservationStatus, string>> = {
  CONFIRMED: 'confirmedAt',
  READY: 'readyAt',
  CUSTOMER_ARRIVED: 'customerArrivedAt',
  COMPLETED: 'completedAt',
  CANCELLED: 'cancelledAt',
};

/**
 * A store's transition request against the CURRENT reservation (read inside the
 * transaction): optimistic concurrency first, then the §15 table, then the extra rules
 * (refusal reason, pickup code). Pure.
 */
export function decideRetailerTransition(
  current: { status: ReservationStatus; quantity: number; pickupCode: string; pickupCodeAttempts: number },
  request: RetailerTransitionRequest,
  nowIso: string,
): TransitionDecision {
  if (current.status !== request.expectedCurrentStatus) return { kind: 'REJECT', reason: 'STALE_STATUS' };
  if (!RETAILER_TARGETS.includes(request.to) || !canTransition(current.status, request.to)) {
    return { kind: 'REJECT', reason: 'INVALID_TRANSITION' };
  }
  const patch: Record<string, string | number | null> = { [TIMESTAMP_FIELD[request.to]!]: nowIso };
  if (request.to === 'CANCELLED') {
    if (!request.cancelReason || !REFUSAL_REASONS.includes(request.cancelReason)) {
      return { kind: 'REJECT', reason: 'REASON_REQUIRED' };
    }
    patch.cancelledBy = 'RETAILER';
    patch.cancelReason = request.cancelReason;
    patch.cancelNote =
      request.cancelReason === 'OTHER' ? (request.cancelNote ?? '').trim().slice(0, CANCEL_NOTE_MAX) || null : null;
  }
  if (request.to === 'COMPLETED') {
    const check = checkPickupCode(current.pickupCode, request.pickupCode, current.pickupCodeAttempts);
    if (check === 'LOCKED') return { kind: 'REJECT', reason: 'PICKUP_CODE_LOCKED' };
    if (check === 'MISMATCH') {
      return { kind: 'REJECT', reason: 'PICKUP_CODE_MISMATCH', pickupCodeAttempts: current.pickupCodeAttempts + 1 };
    }
  }
  return {
    kind: 'APPLY',
    plan: {
      to: request.to,
      effect: inventoryEffect(request.to, current.quantity),
      correctQuantityToReserved: request.to === 'CANCELLED' && request.cancelReason === 'NOT_ACTUALLY_IN_STOCK',
      patch,
    },
  };
}

/** Customer cancel (chat) and system expiry use the same plan shape. */
export function decideSimpleTransition(
  current: { status: ReservationStatus; quantity: number },
  to: 'CANCELLED' | 'EXPIRED',
  patch: Record<string, string | number | null>,
): TransitionDecision {
  if (!canTransition(current.status, to)) return { kind: 'REJECT', reason: 'INVALID_TRANSITION' };
  return {
    kind: 'APPLY',
    plan: { to, effect: inventoryEffect(to, current.quantity), correctQuantityToReserved: false, patch },
  };
}

/**
 * The inventory numbers after a plan (always 0 ≤ reserved ≤ quantity). With a stock
 * correction the remaining reserved units become the whole quantity → available 0.
 */
export function applyInventoryPlan(
  inventory: { quantity: number; reservedQuantity: number },
  plan: Pick<TransitionPlan, 'effect' | 'correctQuantityToReserved'>,
): { quantity: number; reservedQuantity: number } {
  let quantity = Math.max(0, inventory.quantity + plan.effect.onHand);
  let reserved = Math.max(0, inventory.reservedQuantity + plan.effect.reserved);
  if (plan.correctQuantityToReserved) quantity = reserved;
  reserved = Math.min(reserved, quantity);
  return { quantity, reservedQuantity: reserved };
}
