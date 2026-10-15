/**
 * Area names → an approximate location (docs/00 §11.8 Change 12, E5).
 *
 * L5 — stores with an `area` (the demo brand's Ahmedabad network): the customer names an AREA
 * ("Satellite", or an alias such as "Prahlad Nagar"), the origin is that area's centre from the
 * gazetteer below, and only that area's stores are offered. Store names are never areas. A
 * locality the brand does not serve ("Bopal") is recognised, so the agent can name the areas it
 * does serve.
 *
 * Stores without an `area` keep the older rule: a store's localities come from its own name
 * ("Colaba Store" → "colaba") and its address segments, and a text naming exactly one store's
 * locality gives an APPROXIMATE origin at that store. Anything else is not a location: the agent
 * asks, it never guesses.
 */
import type { GeoPoint } from './storeTruth.js';

export interface LocalityStore {
  storeId: string;
  storeName: string;
  city: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** L5: the area the store serves; when set, the store is found through its area only. */
  area?: string | null;
}

export interface AreaDefinition {
  name: string;
  centre: GeoPoint;
  /** Lower-case names a customer may use for the area (the area's own name first). */
  aliases: string[];
}

/** The served areas' centres and aliases (L5; approximate public coordinates). */
export const AREA_GAZETTEER: AreaDefinition[] = [
  {
    name: 'Satellite',
    centre: { latitude: 23.027, longitude: 72.526 },
    aliases: [
      'satellite',
      'satellite road',
      'shyamal',
      'shyamal cross road',
      'jodhpur',
      'jodhpur cross road',
      'prahlad nagar',
      'prahladnagar',
    ],
  },
  {
    name: 'Navrangpura',
    centre: { latitude: 23.0365, longitude: 72.5611 },
    aliases: ['navrangpura', 'cg road', 'c g road', 'university road', 'law garden', 'ellisbridge', 'ellis bridge'],
  },
];

/** Other Ahmedabad localities: recognised as places, but no store serves them (L5). */
export const OTHER_LOCALITIES = [
  'bopal',
  'south bopal',
  'maninagar',
  'vastrapur',
  'bodakdev',
  'thaltej',
  'gota',
  'chandkheda',
  'paldi',
  'vejalpur',
  'naranpura',
  'sabarmati',
  'ghatlodia',
  'memnagar',
  'ambawadi',
  'gurukul',
  'sola',
  'science city',
  'shela',
  'isanpur',
  'naroda',
  'nikol',
  'bapunagar',
  'motera',
  'juhapura',
  'vasna',
  'shahibaug',
  'ashram road',
  'usmanpura',
  'ranip',
  'chandlodia',
  'sindhu bhavan',
  'makarba',
  'sarkhej',
  'gandhinagar',
  'vastral',
  'odhav',
  'jivraj park',
];

const distanceSquared = (a: GeoPoint, b: GeoPoint) =>
  (a.latitude - b.latitude) ** 2 + ((a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180)) ** 2;

/**
 * The areas a brand serves: one per distinct store `area`, with the gazetteer's centre and
 * aliases (an area missing from the gazetteer uses its stores' mid-point and its own name).
 */
export function servedAreas(stores: LocalityStore[]): AreaDefinition[] {
  const byName = new Map<string, LocalityStore[]>();
  for (const s of stores) {
    if (!s.area || s.latitude === null || s.longitude === null) continue;
    const key = s.area.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), s]);
  }
  return [...byName.entries()]
    .map(([key, members]) => {
      const known = AREA_GAZETTEER.find((a) => a.name.toLowerCase() === key);
      if (known) return known;
      const centre = {
        latitude: members.reduce((sum, s) => sum + s.latitude!, 0) / members.length,
        longitude: members.reduce((sum, s) => sum + s.longitude!, 0) / members.length,
      };
      return { name: members[0]!.area!.trim(), centre, aliases: [clean(members[0]!.area!)] };
    })
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

/** Gazetteer order first (Satellite, Navrangpura), then any other area by name. */
const order = (a: AreaDefinition) => {
  const i = AREA_GAZETTEER.findIndex((g) => g.name === a.name);
  return i < 0 ? AREA_GAZETTEER.length : i;
};

/** The served area nearest to a point (a shared location picks its area). */
export function nearestArea(point: GeoPoint, areas: AreaDefinition[]): AreaDefinition | null {
  return [...areas].sort((a, b) => distanceSquared(point, a.centre) - distanceSquared(point, b.centre))[0] ?? null;
}

/** The served area a name refers to ("satellite", "Satellite"), or null. */
export const areaNamed = (name: string | null | undefined, areas: AreaDefinition[]) =>
  name ? (areas.find((a) => a.name.toLowerCase() === name.trim().toLowerCase()) ?? null) : null;

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

/** The short name used in replies and in unmet-demand areas ("colaba"; L5: the store's area). */
export const primaryLocality = (store: Pick<LocalityStore, 'storeName' | 'city' | 'address' | 'area'>) =>
  store.area?.trim() || (storeLocalities(store)[0] ?? clean(store.city));

export type LocalityResolution =
  /** `area` is set when the origin is a served area's centre (L5); then only its stores count. */
  | { status: 'MATCH'; locality: string; storeId: string | null; origin: GeoPoint; area?: string }
  | { status: 'NONE' }
  | { status: 'AMBIGUOUS'; localities: string[] }
  /** L5: a known place the brand has no store in; `served` names the areas it does serve. */
  | { status: 'UNSERVED'; locality: string; served: string[] };

const mentions = (haystack: string, name: string) => haystack.includes(` ${name} `);

export function resolveLocality(text: string, stores: LocalityStore[]): LocalityResolution {
  const haystack = ` ${clean(text)} `;
  const areas = servedAreas(stores);
  if (areas.length > 0) {
    const named = areas.filter((a) => a.aliases.some((alias) => mentions(haystack, clean(alias))));
    if (named.length > 1) return { status: 'AMBIGUOUS', localities: named.map((a) => a.name) };
    if (named.length === 1) {
      const area = named[0]!;
      return { status: 'MATCH', locality: area.name, storeId: null, origin: area.centre, area: area.name };
    }
    const elsewhere = OTHER_LOCALITIES.find((name) => mentions(haystack, name));
    if (elsewhere) return { status: 'UNSERVED', locality: elsewhere, served: areas.map((a) => a.name) };
  }
  const matches = new Map<string, { locality: string; store: LocalityStore }>();
  for (const store of stores) {
    if (store.latitude === null || store.longitude === null) continue;
    if (store.area) continue; // an area store is found through its area, never its own name
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

/**
 * L5: the one store, among those just shown to the customer, that a text names — by its full
 * name ("GlowUp Beauty") or short name ("GlowUp"), spaces ignored ("Health Plus"). Null when
 * none or more than one match: a typed name never holds anything by itself.
 */
export function namedShownStore(
  text: string,
  shown: { store_id: string; store_name: string; short_name: string | null }[],
): string | null {
  const haystack = ` ${clean(text)} `;
  const compact = haystack.replace(/ /g, '');
  const hits = shown.filter((s) =>
    [s.store_name, s.short_name ?? ''].some((name) => {
      const n = clean(name);
      if (n.length < 3) return false;
      return mentions(haystack, n) || (n.replace(/ /g, '').length >= 6 && compact.includes(n.replace(/ /g, '')));
    }),
  );
  return hits.length === 1 ? hits[0]!.store_id : null;
}

/** ~5 km grid cell for coarse unmet-demand areas (0.045° ≈ 5 km of latitude). */
export const gridCell5km = (p: GeoPoint) => `g5:${Math.floor(p.latitude / 0.045)}:${Math.floor(p.longitude / 0.045)}`;

/** Customer locations are kept at 2 decimal places (~1 km). */
export const roundCoordinate = (value: number) => Math.round(value * 100) / 100;
