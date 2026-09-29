/**
 * Store truth: pure, deterministic rules used to answer "where can I get this now?"
 * (docs/06_INTEGRATION_CONTRACTS.md §4 StoreService). The AI never computes these; from
 * M5 it receives their results, including why each store was excluded.
 */
import { isOpenNow, type StoreHours } from './storeHours.js';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** available_quantity = quantity − reserved_quantity (docs/04 §10), never negative. */
export function availableQuantity(quantity: number, reservedQuantity: number): number {
  return Math.max(0, quantity - reservedQuantity);
}

export const LOW_STOCK_THRESHOLD = 3;
export type AvailabilityStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';

/** Derived deterministically from the stored numbers. */
export function deriveAvailabilityStatus(quantity: number, reservedQuantity: number): AvailabilityStatus {
  const available = availableQuantity(quantity, reservedQuantity);
  if (available <= 0) return 'OUT_OF_STOCK';
  if (available <= LOW_STOCK_THRESHOLD) return 'LOW_STOCK';
  return 'IN_STOCK';
}

export type ExclusionReason = 'INACTIVE' | 'RESERVATIONS_DISABLED' | 'TOO_FAR' | 'CLOSED' | 'OUT_OF_STOCK';

export interface EligibilityCandidate {
  store: {
    storeId: string;
    storeName: string;
    latitude: number | null;
    longitude: number | null;
    storeStatus: string;
    reservationAvailable: boolean;
    pickupAvailable: boolean;
    storeHours: StoreHours | null;
  };
  /** The store's stock of the requested variant, or null when it has none on record. */
  inventory: { quantity: number; reservedQuantity: number } | null;
}

export interface EligibleStore {
  storeId: string;
  storeName: string;
  distanceKm: number;
  availableQuantity: number;
}

export interface ExcludedStore {
  storeId: string;
  storeName: string;
  reason: ExclusionReason;
  distanceKm: number | null;
}

export interface EligibilityResult {
  /** Nearest first. */
  eligible: EligibleStore[];
  /** Every other store with the first reason that excluded it (shown in the M5 decision trace). */
  excluded: ExcludedStore[];
}

/**
 * A store is eligible for a reservation/pickup when it is ACTIVE, accepts reservations
 * and pickups, lies within the radius, is open now, and has available stock.
 * Reasons are checked in that order, so each excluded store gets exactly one reason.
 */
export function findEligibleStores(input: {
  origin: GeoPoint;
  radiusKm: number;
  now: Date;
  candidates: EligibilityCandidate[];
}): EligibilityResult {
  const eligible: EligibleStore[] = [];
  const excluded: ExcludedStore[] = [];

  for (const { store, inventory } of input.candidates) {
    const distanceKm =
      store.latitude === null || store.longitude === null
        ? null
        : haversineDistanceKm(input.origin, { latitude: store.latitude, longitude: store.longitude });
    const available = inventory ? availableQuantity(inventory.quantity, inventory.reservedQuantity) : 0;

    const reason: ExclusionReason | null =
      store.storeStatus !== 'ACTIVE'
        ? 'INACTIVE'
        : !store.reservationAvailable || !store.pickupAvailable
          ? 'RESERVATIONS_DISABLED'
          : distanceKm === null || distanceKm > input.radiusKm
            ? 'TOO_FAR'
            : !isOpenNow(store.storeHours, input.now)
              ? 'CLOSED'
              : available <= 0
                ? 'OUT_OF_STOCK'
                : null;

    if (reason) excluded.push({ storeId: store.storeId, storeName: store.storeName, reason, distanceKm });
    else
      eligible.push({
        storeId: store.storeId,
        storeName: store.storeName,
        distanceKm: distanceKm!,
        availableQuantity: available,
      });
  }

  eligible.sort((a, b) => a.distanceKm - b.distanceKm || a.storeId.localeCompare(b.storeId));
  return { eligible, excluded };
}
