/**
 * The AI Action Guardrail (docs/07_SECURITY_SPEC.md §7): re-verifies a proposed action
 * against FRESH data read by the pipeline, before anything is written. Pure: the caller
 * reads the store, stock, policy and pending proposal; this decides.
 */
import { isOpenNow, type StoreHours } from './storeHours.js';
import { availableQuantity, haversineDistanceKm, type GeoPoint } from './storeTruth.js';
import type { ReservationPolicy } from './reservationStatus.js';

export const GUARDRAIL_BLOCK_CODES = [
  'OUT_OF_STOCK',
  'STORE_CLOSED',
  'NOT_ELIGIBLE',
  'SCOPE_VIOLATION',
  'AMBIGUOUS',
] as const;
export type GuardrailBlockCode = (typeof GUARDRAIL_BLOCK_CODES)[number];

export type GuardrailVerdict = { status: 'ALLOWED' } | { status: 'BLOCKED'; reason: GuardrailBlockCode };

const ALLOWED: GuardrailVerdict = { status: 'ALLOWED' };
const block = (reason: GuardrailBlockCode): GuardrailVerdict => ({ status: 'BLOCKED', reason });

export interface PendingProposal {
  storeId: string;
  variantId: string;
  quantity: number;
  proposedAt: string;
  expiresAt: string;
  offeredStores: string[];
  /**
   * Set only by the refusal re-offer (judge-test fixes): the store was offered beyond the
   * normal radius, with its distance, because no nearer store had it. Applies to `storeId` only.
   */
  radiusKm?: number;
}

/** The radius a hold at `storeId` is checked against: wider only for the pending proposal's own store. */
export function holdRadiusKm(pending: PendingProposal, storeId: string, normalRadiusKm: number): number {
  return pending.radiusKm && pending.storeId === storeId
    ? Math.max(normalRadiusKm, Math.min(pending.radiusKm, 25))
    : normalRadiusKm;
}

export const isProposalLive = (p: PendingProposal | null, now: Date): p is PendingProposal =>
  !!p && now.getTime() < new Date(p.expiresAt).getTime();

export interface ReservationCheck {
  proposal: { storeId: string | null; variantId: string | null; quantity: number };
  pending: PendingProposal | null;
  /** The target store as read from THIS brand (null = not in this brand). */
  store: {
    storeStatus: string;
    reservationAvailable: boolean;
    pickupAvailable: boolean;
    storeHours: StoreHours | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  inventory: { quantity: number; reservedQuantity: number } | null;
  policy: ReservationPolicy;
  origin: GeoPoint | null;
  radiusKm: number;
  now: Date;
}

/**
 * create_reservation. Order: scope → no live proposal → eligibility → hours → stock →
 * not an offered store, so a block carries the verified store fact whenever there is one.
 */
export function checkReservationProposal(c: ReservationCheck): GuardrailVerdict {
  if (!c.proposal.storeId || !c.proposal.variantId) return block('AMBIGUOUS');
  if (!c.store) return block('SCOPE_VIOLATION');
  if (!isProposalLive(c.pending, c.now)) return block('AMBIGUOUS');
  if (c.pending.variantId !== c.proposal.variantId) return block('AMBIGUOUS');
  if (
    c.store.storeStatus !== 'ACTIVE' ||
    !c.store.reservationAvailable ||
    !c.store.pickupAvailable ||
    !c.policy.reservationsEnabled ||
    c.proposal.quantity < 1 ||
    c.proposal.quantity > c.policy.maxQuantityPerReservation
  )
    return block('NOT_ELIGIBLE');
  if (c.origin && c.store.latitude !== null && c.store.longitude !== null) {
    const km = haversineDistanceKm(c.origin, { latitude: c.store.latitude, longitude: c.store.longitude });
    if (km > holdRadiusKm(c.pending, c.proposal.storeId, c.radiusKm)) return block('NOT_ELIGIBLE');
  }
  if (!isOpenNow(c.store.storeHours, c.now)) return block('STORE_CLOSED');
  const available = c.inventory ? availableQuantity(c.inventory.quantity, c.inventory.reservedQuantity) : 0;
  if (available < c.proposal.quantity) return block('OUT_OF_STOCK');
  // A store the customer was never offered is not what they confirmed: ask first.
  if (!c.pending.offeredStores.includes(c.proposal.storeId)) return block('AMBIGUOUS');
  return ALLOWED;
}

/** cancel_reservation: only the customer's own reservation in this brand. */
export function checkCancelProposal(c: {
  reservationId: string | null;
  reservation: { customerId: string; status: string } | null;
  customerId: string;
  cancellable: boolean;
}): GuardrailVerdict {
  if (!c.reservationId) return block('AMBIGUOUS');
  if (!c.reservation || c.reservation.customerId !== c.customerId) return block('SCOPE_VIOLATION');
  return c.cancellable ? ALLOWED : block('NOT_ELIGIBLE');
}

/**
 * Store options in a reply (STORE_DISCOVERY / ALTERNATIVE_PRODUCT): every offered store
 * must be eligible for that variant in a tool result of THIS run.
 */
export function checkOfferedStores(offered: string[], eligibleStoreIds: Set<string>): GuardrailVerdict {
  return offered.every((id) => eligibleStoreIds.has(id)) ? ALLOWED : block('NOT_ELIGIBLE');
}
