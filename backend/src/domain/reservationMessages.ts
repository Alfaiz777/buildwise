/**
 * Customer notifications for store updates (docs/00 §11.8 Change 13, F4). Deterministic,
 * built only from verified data (the reservation, the store, the catalogue). A refusal
 * never shows the store's internal note and never blames the customer.
 */
import { formatHoldUntil, type Reply } from './agentReplies.js';

export type ReservationUpdateEvent = 'CONFIRMED' | 'READY' | 'REFUSED' | 'EXPIRED' | 'COMPLETED';

/**
 * Named templates used outside the 24-hour window (registry kept in code until L2).
 * COMPLETED has none: the thank-you is sent only inside the window, never as a template.
 */
export const RESERVATION_TEMPLATES: Partial<Record<ReservationUpdateEvent, string>> = {
  CONFIRMED: 'qwikspot_reservation_confirmed_v1',
  READY: 'qwikspot_reservation_ready_v1',
  REFUSED: 'qwikspot_reservation_refused_v1',
  EXPIRED: 'qwikspot_reservation_expired_v1',
};

export interface ReservationFacts {
  reservationId: string;
  storeName: string;
  storeTimezone: string;
  latitude: number | null;
  longitude: number | null;
  /** The store's address, for the location part (Change 16). */
  storeAddress?: string | null;
  productLabel: string;
  quantity: number;
  pickupCode: string;
  expiresAt: string;
  variantId: string;
}

const qty = (f: ReservationFacts) => (f.quantity > 1 ? `${f.quantity} × ${f.productLabel}` : f.productLabel);
const qtyLine = (f: ReservationFacts) => `${f.quantity} × ${f.productLabel}`;

export const RECHECK_OPTION = (variantId: string) => `recheck:${variantId}`;

/** The store's location as a location part (sent as a location message on WhatsApp). */
const storeLocation = (f: ReservationFacts) =>
  f.latitude !== null && f.longitude !== null
    ? {
        location: {
          name: f.storeName,
          address: f.storeAddress || f.storeName,
          latitude: f.latitude,
          longitude: f.longitude,
        },
      }
    : undefined;

export function confirmedMessage(f: ReservationFacts, now: Date): Reply {
  return {
    message_type: 'INTERACTIVE',
    text: [
      `✅ *${f.storeName} confirmed your hold*`,
      qtyLine(f),
      `Pickup code: *${f.pickupCode}* · held until ${formatHoldUntil(f.expiresAt, f.storeTimezone, now)} (store time)`,
    ].join('\n'),
    options: [{ option_id: `cancel:${f.reservationId}`, label: 'Cancel reservation' }],
  };
}

export function readyMessage(f: ReservationFacts): Reply {
  return {
    message_type: 'TEXT',
    text: [`🛍️ *Ready at ${f.storeName}*`, qtyLine(f), `Show code *${f.pickupCode}* at the counter.`].join('\n'),
    parts: storeLocation(f),
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

/**
 * After pickup (judge-test fixes): one short thank-you from the brand, plain text (so no
 * "Powered by Qwikspot" footer). Sent only inside the 24-hour window; "Customer arrived" sends nothing.
 */
export function thankYouMessage(f: Pick<ReservationFacts, 'storeName' | 'productLabel'>, brandName: string): Reply {
  return {
    message_type: 'TEXT',
    text: `Thanks for picking up *${f.productLabel}* at ${f.storeName}. Enjoy it! — ${brandName}`,
  };
}
