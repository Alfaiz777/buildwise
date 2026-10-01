/**
 * Outcomes & insights (docs/00 §11.8 Change 13, F8). Pure and deterministic: every number
 * is a count over stored records, every sentence is a rule over those numbers (no AI text),
 * and weekdays are taken in the store's timezone.
 */
import type { AiAction } from './ai.js';
import { converted, INTENDED_PURCHASE, PURCHASE_TYPES, type PurchaseType } from './outcomeRules.js';
import { storeLocalTime, WEEKDAYS, type Weekday } from './storeHours.js';

export interface InsightRows {
  intents: { intentId: string; detectedAt: string; followUpSentAt: string | null }[];
  conversations: { conversationId: string; startedAt: string }[];
  recommendations: { recommendationId: string; action: AiAction; proposedAt: string }[];
  /** STORE_RECOMMENDATION events (one per store lookup that ended in an offer or in no store). */
  lookups: {
    eventId: string;
    timestamp: string;
    kind: 'PROPOSED' | 'UNMET_DEMAND';
    variantId: string | null;
    sku: string | null;
    area: string | null;
    excluded: { storeId: string; reason: string }[];
    nearestStoreId: string | null;
    nearestReason: string | null;
    timezone: string | null;
  }[];
  reservations: {
    reservationId: string;
    storeId: string;
    variantId: string;
    status: string;
    createdAt: string;
    cancelledBy: string | null;
    cancelReason: string | null;
  }[];
  outcomes: { outcomeId: string; purchaseType: PurchaseType; aiRecommendationId: string | null; timestamp: string }[];
}

export interface InsightCatalog {
  stores: { storeId: string; storeName: string; locality: string; retailerName: string | null; timezone: string }[];
  variants: { variantId: string; sku: string; label: string }[];
  defaultTimezone: string;
}

const weekdayOf = (iso: string, tz: string) => storeLocalTime(tz, new Date(iso)).weekday as Weekday;
const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------ 1. funnel

export function funnel(rows: InsightRows) {
  const outcomes = Object.fromEntries(PURCHASE_TYPES.map((t) => [t, 0])) as Record<PurchaseType, number>;
  for (const o of rows.outcomes) outcomes[o.purchaseType]++;
  return {
    intents: rows.intents.length,
    follow_ups_sent: rows.intents.filter((i) => i.followUpSentAt).length,
    conversations: rows.conversations.length,
    store_recommendations: rows.lookups.filter((l) => l.kind === 'PROPOSED').length,
    reservations: rows.reservations.length,
    completed: rows.reservations.filter((r) => r.status === 'COMPLETED').length,
    outcomes,
  };
}

// ------------------------------------------------------------------ 2. conversion by action (docs/04 §16.1)

export function conversionByAction(rows: InsightRows) {
  const actionOf = new Map(rows.recommendations.map((r) => [r.recommendationId, r.action]));
  const byAction = new Map<AiAction, { outcomes: number; converted: number; recorded: Record<string, number> }>();
  for (const o of rows.outcomes) {
    const action = o.aiRecommendationId ? actionOf.get(o.aiRecommendationId) : undefined;
    if (!action) continue;
    const entry = byAction.get(action) ?? { outcomes: 0, converted: 0, recorded: {} };
    entry.outcomes++;
    entry.recorded[o.purchaseType] = (entry.recorded[o.purchaseType] ?? 0) + 1;
    if (converted(action, o.purchaseType)) entry.converted++;
    byAction.set(action, entry);
  }
  return [...byAction.entries()]
    .map(([action, e]) => ({
      action,
      intended: INTENDED_PURCHASE[action],
      outcomes: e.outcomes,
      recorded: e.recorded,
      converted: e.converted,
      rate_pct: INTENDED_PURCHASE[action] ? pct(e.converted, e.outcomes) : null,
    }))
    .sort((a, b) => b.outcomes - a.outcomes || a.action.localeCompare(b.action));
}

// ------------------------------------------------------------------ 3. unmet local demand

export function unmetDemand(rows: InsightRows, catalog: InsightCatalog) {
  const groups = new Map<
    string,
    { sku: string; area: string; weekday: Weekday; count: number; reasons: Record<string, number>; eventIds: string[] }
  >();
  for (const l of rows.lookups) {
    if (l.kind !== 'UNMET_DEMAND' || !l.sku) continue;
    const weekday = weekdayOf(l.timestamp, l.timezone ?? catalog.defaultTimezone);
    const area = l.area ?? 'unknown';
    const key = `${l.sku}|${area}|${weekday}`;
    const g = groups.get(key) ?? { sku: l.sku, area, weekday, count: 0, reasons: {}, eventIds: [] };
    g.count++;
    g.eventIds.push(l.eventId);
    for (const x of l.excluded) g.reasons[x.reason] = (g.reasons[x.reason] ?? 0) + 1;
    groups.set(key, g);
  }
  const label = (sku: string) => catalog.variants.find((v) => v.sku === sku)?.label ?? sku;
  return [...groups.values()]
    .map((g) => ({ ...g, label: label(g.sku) }))
    .sort(
      (a, b) =>
        b.count - a.count || a.sku.localeCompare(b.sku) || WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday),
    );
}

// ------------------------------------------------------------------ 4. demand vs availability by weekday

export function weekdayPanel(rows: InsightRows, catalog: InsightCatalog, sku?: string) {
  const tz = catalog.defaultTimezone;
  const lookups = rows.lookups.filter((l) => !sku || l.sku === sku);
  const variantIds = sku ? new Set(catalog.variants.filter((v) => v.sku === sku).map((v) => v.variantId)) : null;
  const reservations = rows.reservations.filter((r) => !variantIds || variantIds.has(r.variantId));
  return WEEKDAYS.map((weekday) => {
    const day = lookups.filter((l) => weekdayOf(l.timestamp, l.timezone ?? tz) === weekday);
    const noStore = day.filter((l) => l.kind === 'UNMET_DEMAND').length;
    const res = reservations.filter((r) => weekdayOf(r.createdAt, tz) === weekday);
    return {
      weekday,
      lookups: day.length,
      no_store: noStore,
      no_store_pct: pct(noStore, day.length),
      reservations: res.length,
      completions: res.filter((r) => r.status === 'COMPLETED').length,
    };
  });
}

export type ReadingKind = 'AVAILABILITY_PROBLEM' | 'DEMAND_PEAK' | 'STEADY' | 'NOT_ENOUGH_DATA';

/**
 * One deterministic sentence about the most-looked-up SKU. A day "spikes" when it has
 * ≥ 1.5× the other days' average lookups. Availability problem = a spiking day whose
 * no-store share is ≥ 20% and at least twice the other days' (the worst such day is
 * reported). Demand peak = the busiest day spikes but stock kept up. Otherwise steady.
 */
export function weekdayReading(rows: InsightRows, catalog: InsightCatalog) {
  const counts = new Map<string, number>();
  for (const l of rows.lookups) if (l.sku) counts.set(l.sku, (counts.get(l.sku) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!top || top[1] < 7) {
    return {
      kind: 'NOT_ENOUGH_DATA' as ReadingKind,
      sku: top?.[0] ?? null,
      text: 'Not enough store lookups in this period for a weekday reading.',
    };
  }
  return readingFor(top[0], weekdayPanel(rows, catalog, top[0]), catalog);
}

export function readingFor(sku: string, days: ReturnType<typeof weekdayPanel>, catalog: InsightCatalog) {
  const label = catalog.variants.find((v) => v.sku === sku)?.label ?? sku;
  const statsFor = (day: (typeof days)[number]) => {
    const others = days.filter((d) => d.weekday !== day.weekday);
    const avg = others.reduce((s, d) => s + d.lookups, 0) / others.length;
    const otherPct = pct(
      others.reduce((s, d) => s + d.no_store, 0),
      others.reduce((s, d) => s + d.lookups, 0),
    );
    const ratio = avg === 0 ? (day.lookups > 0 ? Infinity : 0) : day.lookups / avg;
    const spike = ratio >= 1.5;
    const availability = spike && day.no_store_pct >= 20 && day.no_store_pct >= 2 * otherPct;
    return { day, ratio, otherPct, spike, availability };
  };
  const byLookups = [...days].sort(
    (a, b) => b.lookups - a.lookups || WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday),
  );
  const stats = byLookups.map(statsFor);
  // Prefer the spiking day whose lookups most often found no store (the actionable reading),
  // else the busiest day.
  const problem = stats
    .filter((s) => s.availability)
    .sort((a, b) => b.day.no_store_pct - a.day.no_store_pct || b.day.lookups - a.day.lookups)[0];
  const chosen = problem ?? stats[0]!;
  const { day: peak, ratio, otherPct } = chosen;
  const ratioText = Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : 'far above';
  const dayName = titleCase(peak.weekday);
  let kind: ReadingKind = 'STEADY';
  let text: string;
  if (chosen.availability) {
    kind = 'AVAILABILITY_PROBLEM';
    text = `${dayName} lookups for ${label} were ${ratioText} the other days' average, but ${peak.no_store_pct}% found no store with stock (other days: ${otherPct}%). This looks like an availability problem, not a demand problem.`;
  } else if (chosen.spike) {
    kind = 'DEMAND_PEAK';
    text = `${dayName} lookups for ${label} were ${ratioText} the other days' average, and ${peak.no_store_pct}% found no store with stock (other days: ${otherPct}%). Demand peaks on ${dayName}s and stock kept up.`;
  } else {
    text = `Lookups for ${label} are steady across the week (busiest: ${dayName}, ${peak.lookups}); ${otherPct}% of other-day lookups found no store with stock.`;
  }
  return {
    kind,
    sku,
    peak_weekday: peak.weekday,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
    peak_no_store_pct: peak.no_store_pct,
    other_no_store_pct: otherPct,
    text,
  };
}

// ------------------------------------------------------------------ 5. fill rate by store × weekday

export function fillRate(rows: InsightRows, catalog: InsightCatalog) {
  const tz = catalog.defaultTimezone;
  const out: {
    store_id: string;
    store_name: string;
    weekday: Weekday;
    nearest: number;
    had_stock: number;
    fill_pct: number;
    refusals: Record<string, number>;
  }[] = [];
  for (const store of catalog.stores) {
    for (const weekday of WEEKDAYS) {
      const nearest = rows.lookups.filter(
        (l) => l.nearestStoreId === store.storeId && weekdayOf(l.timestamp, l.timezone ?? tz) === weekday,
      );
      const refusals: Record<string, number> = {};
      for (const r of rows.reservations) {
        if (
          r.storeId !== store.storeId ||
          r.cancelledBy !== 'RETAILER' ||
          weekdayOf(r.createdAt, store.timezone) !== weekday
        )
          continue;
        refusals[r.cancelReason ?? 'OTHER'] = (refusals[r.cancelReason ?? 'OTHER'] ?? 0) + 1;
      }
      if (nearest.length === 0 && Object.keys(refusals).length === 0) continue;
      const hadStock = nearest.filter((l) => l.nearestReason === null).length;
      out.push({
        store_id: store.storeId,
        store_name: store.storeName,
        weekday,
        nearest: nearest.length,
        had_stock: hadStock,
        fill_pct: pct(hadStock, nearest.length),
        refusals,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ 6. suggested next actions (display only)

export interface Suggestion {
  rule: 'STOCK_UNMET_AREA' | 'RAISE_STOCK_BEFORE_PEAK' | 'REUPLOAD_STOCK';
  text: string;
  evidence: { kind: 'EVENTS' | 'RESERVATIONS'; ids: string[] };
}

export const UNMET_THRESHOLD = 3;
export const REFUSAL_THRESHOLD = 2;

export function suggestions(rows: InsightRows, catalog: InsightCatalog, days: number): Suggestion[] {
  const out: Suggestion[] = [];
  const period = `in the last ${days} days`;
  const storeByLocality = (area: string) => catalog.stores.find((s) => s.locality === area) ?? null;
  const label = (sku: string) => catalog.variants.find((v) => v.sku === sku)?.label ?? sku;

  // Rule 1: repeated unmet demand for a SKU in an area → ask the area store's retailer to stock it.
  const unmet = new Map<string, { sku: string; area: string; ids: string[] }>();
  for (const l of rows.lookups) {
    if (l.kind !== 'UNMET_DEMAND' || !l.sku || !l.area) continue;
    const key = `${l.sku}|${l.area}`;
    const g = unmet.get(key) ?? { sku: l.sku, area: l.area, ids: [] };
    g.ids.push(l.eventId);
    unmet.set(key, g);
  }
  for (const g of [...unmet.values()].sort((a, b) => b.ids.length - a.ids.length || a.sku.localeCompare(b.sku))) {
    if (g.ids.length < UNMET_THRESHOLD) continue;
    const store = storeByLocality(g.area);
    const who = store?.retailerName
      ? `ask ${store.retailerName} to stock ${store.storeName}`
      : `stock a store near ${titleCase(g.area)}`;
    out.push({
      rule: 'STOCK_UNMET_AREA',
      text: `${label(g.sku)} was requested ${g.ids.length} times in ${titleCase(g.area)} ${period} with no store in stock. Suggested: ${who}.`,
      evidence: { kind: 'EVENTS', ids: g.ids },
    });
  }

  // Rule 2: a weekday availability problem → raise the store that runs out (nearest + out of stock) before that day.
  const skus = [...new Set(rows.lookups.map((l) => l.sku).filter((s): s is string => !!s))].sort();
  for (const sku of skus) {
    const panel = weekdayPanel(rows, catalog, sku);
    if (panel.reduce((s, d) => s + d.lookups, 0) < 7) continue;
    const reading = readingFor(sku, panel, catalog);
    if (reading.kind !== 'AVAILABILITY_PROBLEM') continue;
    const tz = catalog.defaultTimezone;
    const outs = rows.lookups.filter(
      (l) =>
        l.sku === sku &&
        l.nearestReason === 'OUT_OF_STOCK' &&
        weekdayOf(l.timestamp, l.timezone ?? tz) === reading.peak_weekday,
    );
    const byStore = new Map<string, string[]>();
    for (const l of outs) byStore.set(l.nearestStoreId!, [...(byStore.get(l.nearestStoreId!) ?? []), l.eventId]);
    const worst = [...byStore.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!worst) continue;
    const store = catalog.stores.find((s) => s.storeId === worst[0]);
    out.push({
      rule: 'RAISE_STOCK_BEFORE_PEAK',
      text: `${store?.storeName ?? worst[0]} was the nearest store but out of stock of ${label(sku)} ${worst[1].length} times on ${titleCase(reading.peak_weekday)}s ${period}. Suggested: raise its ${label(sku)} stock before ${titleCase(reading.peak_weekday)}.`,
      evidence: { kind: 'EVENTS', ids: worst[1] },
    });
  }

  // Rule 3: repeated "not actually in stock" refusals → the store's uploaded stock is wrong.
  const refused = new Map<string, string[]>();
  for (const r of rows.reservations) {
    if (r.cancelledBy === 'RETAILER' && r.cancelReason === 'NOT_ACTUALLY_IN_STOCK') {
      refused.set(r.storeId, [...(refused.get(r.storeId) ?? []), r.reservationId]);
    }
  }
  for (const [storeId, ids] of [...refused.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    if (ids.length < REFUSAL_THRESHOLD) continue;
    const store = catalog.stores.find((s) => s.storeId === storeId);
    out.push({
      rule: 'REUPLOAD_STOCK',
      text: `${store?.storeName ?? storeId} refused ${ids.length} reservations as "not actually in stock" ${period}. Suggested: ask ${store?.retailerName ?? 'its retailer'} to re-upload ${store?.storeName ?? 'the store'}'s stock file.`,
      evidence: { kind: 'RESERVATIONS', ids },
    });
  }
  return out;
}
