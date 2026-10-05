import { REFUSAL_TEXT, type ConversationRow, type ReservationRow } from './conversationTypes';
import type { InsightsResponse } from './InsightsPage';
import { formatPrice, type BrandStore } from './types';

/**
 * The Brand Overview's numbers and alerts (Change 16, UI-3; audit P0-1, P1-6). Pure:
 * every KPI is a field of GET /api/brand/insights, every alert a filter over records the
 * console already loads. Nothing is estimated except the value, which says "est.".
 */
export interface Kpi {
  key: string;
  label: string;
  value: string;
  sub?: string;
  estimated?: boolean;
}

const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 100));

export function kpis(d: InsightsResponse): Kpi[] {
  const f = d.funnel;
  const online = (f.outcomes.ONLINE ?? 0) + (f.outcomes.ALTERNATIVE ?? 0);
  const purchases = (f.outcomes.OFFLINE ?? 0) + online;
  // Conversion = finished journeys (a recorded outcome) that ended in a purchase. Not per
  // conversation: a customer's conversation can start long before the period.
  const finished = purchases + (f.outcomes.NONE ?? 0);
  const conversion = pct(purchases, finished);
  const tiles: Kpi[] = [
    { key: 'intents', label: 'Intents caught', value: String(f.intents), sub: 'shoppers showing buying intent' },
    {
      key: 'conversations',
      label: 'New conversations',
      value: String(f.conversations),
      sub: 'started on WhatsApp in this period',
    },
    { key: 'holds', label: 'Holds', value: String(f.reservations), sub: 'reserved at a store' },
    { key: 'pickups', label: 'Pickups', value: String(f.completed), sub: 'collected in store' },
    { key: 'online', label: 'Online orders', value: String(online), sub: 'from chat links' },
    {
      key: 'conversion',
      label: 'Conversion',
      value: conversion === null ? '—' : `${conversion}%`,
      sub: conversion === null ? 'no finished journeys yet' : `${purchases} of ${finished} finished journeys bought`,
    },
  ];
  if (f.value) {
    tiles.push({
      key: 'value',
      label: 'Value of purchases',
      value: formatPrice(f.value.amount, f.value.currency ?? 'INR'),
      sub: 'recorded pickups and orders',
      estimated: true,
    });
  }
  return tiles;
}

export interface AttentionItem {
  key: string;
  text: string;
  to: string;
  tone: 'warning' | 'danger' | 'info';
}

const DAY_MS = 24 * 60 * 60_000;
const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
const age = (ms: number) => {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)} days` : `${h} h`;
};

export function attentionItems(input: {
  conversations: ConversationRow[];
  reservations: ReservationRow[];
  stores: BrandStore[];
  freshnessHours: number | null;
  mappingIssues: number;
  now: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { now } = input;

  const waiting = input.conversations.filter((c) => c.human_handoff);
  if (waiting.length) {
    const longest = Math.max(...waiting.map((c) => (c.handoff_at ? minutesSince(c.handoff_at, now) : 0)));
    items.push({
      key: 'handoff',
      text: `${waiting.length} customer${waiting.length === 1 ? ' is' : 's are'} waiting for a person — longest ${longest} min`,
      to: '/brand/conversations?filter=handoff',
      tone: 'warning',
    });
  }

  const refusals = input.reservations.filter(
    (r) =>
      r.status === 'CANCELLED' &&
      r.cancelled_by === 'RETAILER' &&
      r.cancelled_at &&
      now - Date.parse(r.cancelled_at) <= DAY_MS,
  );
  const byStore = new Map<string, ReservationRow[]>();
  for (const r of refusals) byStore.set(r.store_name, [...(byStore.get(r.store_name) ?? []), r]);
  for (const [store, rows] of byStore) {
    const reasons = [...new Set(rows.map((r) => REFUSAL_TEXT[r.cancel_reason ?? ''] ?? 'no reason given'))];
    items.push({
      key: `refusal-${store}`,
      text: `${store} refused ${rows.length} hold${rows.length === 1 ? '' : 's'} in the last 24 h — ${reasons.join(', ')}`,
      to: '/brand/reservations?filter=refused',
      tone: 'danger',
    });
  }

  if (input.freshnessHours !== null) {
    const limit = input.freshnessHours * 3_600_000;
    for (const s of input.stores) {
      if (s.sku_count === 0 || !s.stock_updated_at) continue;
      const ms = now - Date.parse(s.stock_updated_at);
      if (ms > limit) {
        items.push({
          key: `stale-${s.store_id}`,
          text: `${s.store_name} stock is ${age(ms)} old — ask for a fresh retail file`,
          to: `/brand/network#store-${s.store_id}`,
          tone: 'info',
        });
      }
    }
  }

  if (input.mappingIssues > 0) {
    items.push({
      key: 'mapping',
      text: `${input.mappingIssues} retail SKU${input.mappingIssues === 1 ? ' needs' : 's need'} attention — their stock is not used yet`,
      to: '/brand/network#catalog',
      tone: 'info',
    });
  }
  return items;
}
