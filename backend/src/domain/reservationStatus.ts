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
