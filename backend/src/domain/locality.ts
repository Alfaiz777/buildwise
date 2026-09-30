/**
 * Area names → an approximate location (docs/00 §11.8 Change 12, E5). A store's localities
 * come from its own name ("Bandra Store" → "bandra") and its address segments ("Andheri
 * West" → "andheri west", "andheri"). A customer's text that names exactly one store's
 * locality gives an APPROXIMATE origin at that store. Anything else is not a location:
 * the agent asks, it never guesses.
 */
import type { GeoPoint } from './storeTruth.js';

export interface LocalityStore {
  storeId: string;
  storeName: string;
  city: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

const DIRECTIONS = new Set(['west', 'east', 'north', 'south']);
const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Lower-case locality names for one store, most specific first. */
export function storeLocalities(store: Pick<LocalityStore, 'storeName' | 'city' | 'address'>): string[] {
  const names = new Set<string>();
  const primary = clean(store.storeName.replace(/\bstore\b/i, ''));
  if (primary.length >= 3) names.add(primary);
  const city = clean(store.city);
  for (const segment of (store.address ?? '').split(',')) {
    if (/\d/.test(segment)) continue; // PIN codes, house numbers
    const name = clean(segment);
    if (name.length < 3 || name === city) continue;
    names.add(name);
    const words = name.split(' ');
    if (words.length === 2 && DIRECTIONS.has(words[1]!)) names.add(words[0]!);
  }
  return [...names];
}

/** The short name used in replies and in unmet-demand areas ("bandra"). */
export const primaryLocality = (store: Pick<LocalityStore, 'storeName' | 'city' | 'address'>) =>
  storeLocalities(store)[0] ?? clean(store.city);

export type LocalityResolution =
  | { status: 'MATCH'; locality: string; storeId: string; origin: GeoPoint }
  | { status: 'NONE' }
  | { status: 'AMBIGUOUS'; localities: string[] };

export function resolveLocality(text: string, stores: LocalityStore[]): LocalityResolution {
  const haystack = ` ${clean(text)} `;
  const matches = new Map<string, { locality: string; store: LocalityStore }>();
  for (const store of stores) {
    if (store.latitude === null || store.longitude === null) continue;
    const hit = storeLocalities(store).find((name) => haystack.includes(` ${name} `));
    if (hit && !matches.has(store.storeId)) matches.set(store.storeId, { locality: hit, store });
  }
  if (matches.size === 0) return { status: 'NONE' };
  const distinct = [...new Set([...matches.values()].map((m) => m.locality))];
  if (distinct.length > 1) return { status: 'AMBIGUOUS', localities: distinct.sort() };
  const first = [...matches.values()].sort((a, b) => a.store.storeId.localeCompare(b.store.storeId))[0]!;
  return {
    status: 'MATCH',
    locality: first.locality,
    storeId: first.store.storeId,
    origin: { latitude: first.store.latitude!, longitude: first.store.longitude! },
  };
}

/** ~5 km grid cell for coarse unmet-demand areas (0.045° ≈ 5 km of latitude). */
export const gridCell5km = (p: GeoPoint) => `g5:${Math.floor(p.latitude / 0.045)}:${Math.floor(p.longitude / 0.045)}`;

/** Customer locations are kept at 2 decimal places (~1 km). */
export const roundCoordinate = (value: number) => Math.round(value * 100) / 100;
