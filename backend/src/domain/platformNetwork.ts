/**
 * The Platform Console's retail view (Change 16, UI-5): brand and store AGGREGATES only.
 * Pure. Every input is a count-able record; every output is a count, a rate, an estimated
 * value or a flag. Nothing here returns a customer, a message, a pickup code, a stock line
 * or a person's identity — the callers never pass those through.
 */

export const REFUSAL_KEYS = ['NOT_ACTUALLY_IN_STOCK', 'DAMAGED', 'STORE_CLOSING_EARLY', 'OTHER'] as const;
const ACTIVE = new Set(['PENDING', 'CONFIRMED', 'READY', 'CUSTOMER_ARRIVED']);

export const STORE_FLAGS = [
  'NO_STOCK_UPLOAD',
  'STALE_STOCK',
  'NO_STORE_ADMIN',
  'LOW_FILL_RATE',
  'HIGH_REFUSAL_RATE',
  'STALE_HOLDS',
] as const;
export type StoreFlag = (typeof STORE_FLAGS)[number];

/** Thresholds for the health flags (documented in docs/11 §3). */
export const FLAG_RULES = {
  lowFillMinLookups: 5,
  lowFillBelowPct: 50,
  refusalMinFinished: 3,
  refusalAtLeastPct: 20,
  pendingUnconfirmedMinutes: 30,
} as const;

export interface NetworkReservation {
  storeId: string;
  sku: string;
  quantity: number;
  status: string;
  createdAt: string;
  expiresAt: string;
  cancelledBy: string | null;
  cancelReason: string | null;
}

export interface NetworkLookup {
  kind: 'PROPOSED' | 'UNMET_DEMAND';
  nearestStoreId: string | null;
  nearestReason: string | null;
}

export interface NetworkStore {
  storeId: string;
  storeName: string;
  city: string;
  status: string;
  retailerId: string | null;
  storeAdminProvisioned: boolean;
  /** From the store's stock rows: how many SKUs, the newest update, whether it is stale. */
  stock: { skuCount: number; updatedAt: string | null; stale: boolean };
}

const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 100));

/** Finished = no longer holding stock: completed, refused, expired or cancelled. */
const finished = (r: NetworkReservation) => !ACTIVE.has(r.status);

/** A store is live when it is active, has stock and has its Store Admin. */
export const storeLive = (s: NetworkStore) => s.status === 'ACTIVE' && s.stock.skuCount > 0 && s.storeAdminProvisioned;

/**
 * One store's row: counts over the period's holds and lookups, the holds still active now,
 * and its health flags. `periodHolds` and `lookups` must already be this brand's, in period.
 */
export function storeHealth(input: {
  store: NetworkStore;
  periodHolds: NetworkReservation[];
  activeHolds: NetworkReservation[];
  lookups: NetworkLookup[];
  now: Date;
}) {
  const { store, now } = input;
  const holds = input.periodHolds.filter((r) => r.storeId === store.storeId);
  const done = holds.filter(finished);
  const completed = holds.filter((r) => r.status === 'COMPLETED').length;
  const refusedRows = holds.filter((r) => r.status === 'CANCELLED' && r.cancelledBy === 'RETAILER');
  const refused = Object.fromEntries(REFUSAL_KEYS.map((k) => [k, 0])) as Record<string, number>;
  for (const r of refusedRows) {
    const key = REFUSAL_KEYS.includes(r.cancelReason as (typeof REFUSAL_KEYS)[number]) ? r.cancelReason! : 'OTHER';
    refused[key]!++;
  }
  const nearest = input.lookups.filter((l) => l.nearestStoreId === store.storeId);
  const hadStock = nearest.filter((l) => l.nearestReason === null).length;
  const active = input.activeHolds.filter((r) => r.storeId === store.storeId && ACTIVE.has(r.status));
  const staleHolds = active.filter(
    (r) =>
      new Date(r.expiresAt).getTime() < now.getTime() ||
      (r.status === 'PENDING' &&
        now.getTime() - new Date(r.createdAt).getTime() > FLAG_RULES.pendingUnconfirmedMinutes * 60_000),
  ).length;

  const fillPct = pct(hadStock, nearest.length);
  const flags: StoreFlag[] = [];
  if (store.stock.skuCount === 0) flags.push('NO_STOCK_UPLOAD');
  else if (store.stock.stale) flags.push('STALE_STOCK');
  if (!store.storeAdminProvisioned) flags.push('NO_STORE_ADMIN');
  if (nearest.length >= FLAG_RULES.lowFillMinLookups && (fillPct ?? 100) < FLAG_RULES.lowFillBelowPct) {
    flags.push('LOW_FILL_RATE');
  }
  if (
    done.length >= FLAG_RULES.refusalMinFinished &&
    (pct(refusedRows.length, done.length) ?? 0) >= FLAG_RULES.refusalAtLeastPct
  ) {
    flags.push('HIGH_REFUSAL_RATE');
  }
  if (staleHolds > 0) flags.push('STALE_HOLDS');

  return {
    store_id: store.storeId,
    store_name: store.storeName,
    city: store.city,
    status: store.status,
    store_admin_provisioned: store.storeAdminProvisioned,
    stock: {
      sku_count: store.stock.skuCount,
      freshness: store.stock.skuCount === 0 ? 'NONE' : store.stock.stale ? 'STALE' : 'FRESH',
      updated_at: store.stock.updatedAt,
    },
    holds: holds.length,
    completed,
    refused,
    expired: holds.filter((r) => r.status === 'EXPIRED').length,
    completion_pct: pct(completed, done.length),
    nearest_lookups: nearest.length,
    fill_pct: fillPct,
    active_holds: active.length,
    stale_holds: staleHolds,
    flags,
  };
}

export type StoreHealthRow = ReturnType<typeof storeHealth>;

/**
 * One brand's totals for the period. Offline value = Σ completed quantity × the store's
 * CURRENT offline price for that SKU (an estimate); online = attributed ONLINE/ALTERNATIVE
 * outcomes and their recorded values.
 */
export function brandAggregate(input: {
  stores: NetworkStore[];
  periodHolds: NetworkReservation[];
  lookups: NetworkLookup[];
  outcomes: { purchaseType: string; value?: number; currency?: string | null }[];
  followUpsSent: number;
  offlinePrice: (storeId: string, sku: string) => number | null;
  currency: string;
}) {
  const completed = input.periodHolds.filter((r) => r.status === 'COMPLETED');
  const done = input.periodHolds.filter(finished);
  const online = input.outcomes.filter((o) => o.purchaseType === 'ONLINE' || o.purchaseType === 'ALTERNATIVE');
  const withNearest = input.lookups.filter((l) => l.nearestStoreId !== null);
  return {
    stores_total: input.stores.length,
    stores_live: input.stores.filter(storeLive).length,
    holds: input.periodHolds.length,
    pickups: completed.length,
    offline_value: {
      amount: completed.reduce((sum, r) => sum + r.quantity * (input.offlinePrice(r.storeId, r.sku) ?? 0), 0),
      currency: input.currency,
    },
    online_orders: online.length,
    online_value: {
      amount: online.reduce((sum, o) => sum + (Number.isFinite(o.value) ? (o.value as number) : 0), 0),
      currency: online.find((o) => o.currency)?.currency ?? input.currency,
    },
    completion_pct: pct(completed.length, done.length),
    fill_pct: pct(withNearest.filter((l) => l.nearestReason === null).length, withNearest.length),
    unmet_demand: input.lookups.filter((l) => l.kind === 'UNMET_DEMAND').length,
    follow_ups_sent: input.followUpsSent,
  };
}

export type BrandAggregate = ReturnType<typeof brandAggregate>;

/** Platform totals: counts summed; rates recomputed from the summed parts (never averaged). */
export function sumAggregates(
  brands: { aggregate: BrandAggregate; finished: number; nearest: number; nearestHadStock: number }[],
  currency = 'INR',
) {
  const sum = (f: (a: BrandAggregate) => number) => brands.reduce((s, b) => s + f(b.aggregate), 0);
  const inCurrency = (f: (a: BrandAggregate) => { amount: number; currency: string }) =>
    brands.reduce((s, b) => (f(b.aggregate).currency === currency ? s + f(b.aggregate).amount : s), 0);
  const pickups = sum((a) => a.pickups);
  return {
    stores_total: sum((a) => a.stores_total),
    stores_live: sum((a) => a.stores_live),
    holds: sum((a) => a.holds),
    pickups,
    offline_value: { amount: inCurrency((a) => a.offline_value), currency },
    online_orders: sum((a) => a.online_orders),
    online_value: { amount: inCurrency((a) => a.online_value), currency },
    completion_pct: pct(
      pickups,
      brands.reduce((s, b) => s + b.finished, 0),
    ),
    fill_pct: pct(
      brands.reduce((s, b) => s + b.nearestHadStock, 0),
      brands.reduce((s, b) => s + b.nearest, 0),
    ),
    unmet_demand: sum((a) => a.unmet_demand),
    follow_ups_sent: sum((a) => a.follow_ups_sent),
  };
}
