/**
 * Customer notifications for store updates (docs/00 §11.8 Change 13, F4). Deterministic,
 * built only from verified data (the reservation, the store, the catalogue). A refusal
 * never shows the store's internal note and never blames the customer.
 */
import { formatHoldUntil, mapsLink, type Reply } from './agentReplies.js';

export type ReservationUpdateEvent = 'CONFIRMED' | 'READY' | 'REFUSED' | 'EXPIRED';

/** Named templates used outside the 24-hour window (registry kept in code until L2). */
export const RESERVATION_TEMPLATES: Record<ReservationUpdateEvent, string> = {
  CONFIRMED: 'buildwise_reservation_confirmed_v1',
  READY: 'buildwise_reservation_ready_v1',
  REFUSED: 'buildwise_reservation_refused_v1',
  EXPIRED: 'buildwise_reservation_expired_v1',
};

export interface ReservationFacts {
  reservationId: string;
  storeName: string;
  storeTimezone: string;
  latitude: number | null;
  longitude: number | null;
  productLabel: string;
  quantity: number;
  pickupCode: string;
  expiresAt: string;
  variantId: string;
}

const qty = (f: ReservationFacts) => (f.quantity > 1 ? `${f.quantity} × ${f.productLabel}` : f.productLabel);

export const RECHECK_OPTION = (variantId: string) => `recheck:${variantId}`;

export function confirmedMessage(f: ReservationFacts, now: Date): Reply {
  return {
    message_type: 'INTERACTIVE',
    text: `${f.storeName} has confirmed your reservation for ${qty(f)}. Pickup code ${f.pickupCode}, held until ${formatHoldUntil(f.expiresAt, f.storeTimezone, now)} (store time).`,
    options: [{ option_id: `cancel:${f.reservationId}`, label: 'Cancel reservation' }],
  };
}

export function readyMessage(f: ReservationFacts): Reply {
  const directions =
    f.latitude !== null && f.longitude !== null ? ` Directions: ${mapsLink(f.latitude, f.longitude)}` : '';
  return {
    message_type: 'TEXT',
    text: `Your ${qty(f)} is ready at ${f.storeName}. Show code ${f.pickupCode}.${directions}`,
  };
}

/** The apology that opens a refusal notice (the re-offer is appended by the caller). */
export const refusalApology = (f: Pick<ReservationFacts, 'storeName' | 'productLabel'>) =>
  `Sorry — ${f.storeName} can't fulfil your reservation for ${f.productLabel} after all.`;

export function refusalOnlyMessage(f: ReservationFacts, onlineUrl: string | null): Reply {
  return {
    message_type: onlineUrl ? 'INTERACTIVE' : 'TEXT',
    text: `${refusalApology(f)} Share your location or tell me your area and I'll check other stores.${onlineUrl ? ` You can also order online: ${onlineUrl}` : ''}`,
    ...(onlineUrl ? { options: [{ option_id: 'buy_online', label: 'Buy online' }] } : {}),
  };
}

export function expiredMessage(f: ReservationFacts): Reply {
  return {
    message_type: 'INTERACTIVE',
    text: `Your hold at ${f.storeName} for ${f.productLabel} has expired.`,
    options: [{ option_id: RECHECK_OPTION(f.variantId), label: 'Check stores again' }],
  };
}
