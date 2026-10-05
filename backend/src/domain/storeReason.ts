/**
 * "Why this hold came to you" for the Store Console (Change 16, UI-4). Pure. Built only
 * from the decision trace's store names, distances and exclusion reasons — and it says
 * only THIS store's distance from the customer as a number. Other stores appear by name
 * and reason, never with their distance (with the store's own distance, those could
 * locate the customer). No customer location, area, message or identity is ever used.
 */

/** The parts of a decision trace this function reads (docs/04 §14). */
export interface StoreTrace {
  eligible: { store_id: string; store_name: string; distance_km: number; variant_id: string }[];
  excluded: { store_id: string; store_name: string; reason: string; distance_km: number | null; variant_id: string }[];
}

export interface WhyHere {
  text: string;
  /** This store's distance from the customer (km, one decimal), or null if unknown. */
  distance_km: number | null;
  /** Stores nearer to the customer that could not take the hold: names and reasons only. */
  closer_unavailable: { store_name: string; reason: string }[];
  /** How many stores with stock the customer could choose from. */
  options: number;
}

const REASON_WORDS: Record<string, string> = {
  OUT_OF_STOCK: 'out of stock',
  CLOSED: 'closed',
  INACTIVE: 'inactive',
  RESERVATIONS_DISABLED: 'not taking reservations',
  TOO_FAR: 'too far',
};

const round = (km: number) => Math.round(km * 10) / 10;

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** One entry per store, preferring the reserved variant's rows. */
function perStore<T extends { store_id: string; variant_id: string }>(list: T[], variantId: string): T[] {
  const preferred = list.filter((s) => s.variant_id === variantId);
  const source = preferred.length ? preferred : list;
  const seen = new Set<string>();
  return source.filter((s) => (seen.has(s.store_id) ? false : (seen.add(s.store_id), true)));
}

export function whyThisStore(trace: StoreTrace | null | undefined, storeId: string, variantId: string): WhyHere | null {
  if (!trace) return null;
  const eligible = perStore(trace.eligible ?? [], variantId);
  const excluded = perStore(trace.excluded ?? [], variantId);
  const own = eligible.find((s) => s.store_id === storeId);
  if (!own) return null; // the trace does not describe this store (e.g. a later re-route)
  const km = round(own.distance_km);
  const closerUnavailable = excluded
    .filter((s) => s.distance_km !== null && s.distance_km < own.distance_km && s.reason !== 'TOO_FAR')
    .sort((a, b) => a.distance_km! - b.distance_km!)
    .slice(0, 2)
    .map((s) => ({ store_name: s.store_name, reason: s.reason }));
  const closerWithStock = eligible
    .filter((s) => s.store_id !== storeId && s.distance_km < own.distance_km)
    .sort((a, b) => a.distance_km - b.distance_km);

  let text: string;
  if (closerWithStock.length > 0) {
    text =
      `The customer chose you from ${eligible.length} stores with stock (${km} km away; ` +
      `${closerWithStock[0]!.store_name} was nearer).`;
  } else if (closerUnavailable.length > 0) {
    const words = closerUnavailable.map(
      (s) => `${s.store_name} was closer but ${REASON_WORDS[s.reason] ?? 'unavailable'}`,
    );
    text = `${joinWords(words)}. You were the nearest store with stock — ${km} km from the customer.`;
  } else {
    text = `You were the nearest store with stock — ${km} km from the customer.`;
  }
  return { text, distance_km: km, closer_unavailable: closerUnavailable, options: eligible.length };
}

export const FALLBACK_WHY = (brandName: string) => `A customer of ${brandName} reserved this through WhatsApp.`;
