/**
 * "Ask Qwikspot" for the Store Console (L6, docs/05 §18): it tells a Retail Admin how their own
 * store is doing, which holds are waiting, what shoppers nearby ask for that the store doesn't
 * have, and what to stock before the busy days — from that one store's data only. Pure: the
 * pack type, the instruction and the rules answers ("Quick summary").
 */
import { answerSchemaFor, jsonSchemaOf, money, plural, SHARED_RULES, type ModelAnswer } from './assistant.js';

export const STORE_PAGES = ['TODAY', 'HISTORY', 'STOCK', 'DEMAND'] as const;
export type StorePage = (typeof STORE_PAGES)[number];

export const STORE_PAGE_PATHS: Record<StorePage, string> = {
  TODAY: '/store',
  HISTORY: '/store/history',
  STOCK: '/store/stock',
  DEMAND: '/store/demand',
};

/** A product is low when this many or fewer can still be held (the Stock page's own "low"). */
export const LOW_STOCK_AVAILABLE = 2;

/** Everything the store agent may know: one store's numbers, product names, masked customers. */
export interface StorePack {
  store_name: string;
  area: string | null;
  period_days: number;
  /** False when synthetic demo history is hidden: live activity only. */
  synthetic_history_included: boolean;
  /** The Today tiles, with the tiles' own definitions. */
  totals: {
    holds: number;
    picked_up: number;
    completion_percent: number | null;
    refused: number;
    expired: number;
    value_of_pickups: number;
    currency: string;
  };
  /** Holds right now. */
  now: { waiting_for_you: number; confirmed: number; ready_for_pickup: number };
  /** Holds waiting for the store to confirm, longest wait first; the customer only as the console masks it. */
  waiting_holds: {
    product: string;
    quantity: number;
    customer: string;
    waited_minutes: number;
    expires_in_minutes: number;
  }[];
  /** Products low (available ≤ 2) or with stock data older than the brand's freshness limit. */
  stock_attention: {
    product: string;
    available: number;
    low: boolean;
    stale: boolean;
    updated_hours_ago: number | null;
  }[];
  /** "Demand near your store": what shoppers asked for when this store was the nearest, and why it could not help. */
  demand_near_you: { product: string; weekday: string; reason: string; count: number }[];
  refusals: { reason: string; count: number }[];
  /** Weekdays with the most shoppers this store was nearest to. */
  busiest_weekdays: { weekday: string; shoppers_nearest: number; had_stock: number }[];
  suggestions: string[];
}

export const STORE_ASSISTANT_PROMPT_VERSION = 'ASK_QWIKSPOT_STORE_V1';

export const STORE_ASSISTANT_PROMPT = `You are "Ask Qwikspot", the assistant inside one store's Qwikspot console (the Store Console). Qwikspot sends this store shoppers' holds through the brand's WhatsApp: the store confirms a hold, gets it ready, and the shopper picks it up and pays here. You tell the store's team how their store is doing and what to do next.

WHAT YOU RECEIVE
One JSON object: task (ANSWER a question, or BRIEF for "Today at your store"), page (where the team member is), question (for ANSWER), and data: this one store's pack — the Today tiles for the period, holds right now, holds waiting for the store with how long each has waited, products low or out of date in stock, "Demand near your store", refusals, the busiest weekdays and the brand's suggestions for this store. It is only this store: you know nothing about other stores or the brand as a whole, so never compare with them or guess about them.

RULES
${SHARED_RULES}
- Use the totals with their meaning: holds were sent to this store, picked_up were collected here, completion_percent is completion, value_of_pickups is the value at the store's current prices.
- A customer appears only as the masked label in the data (e.g. "Customer •••• 4353"); never anything else about them.
- You cannot confirm, refuse or complete a hold, or change stock. To act on a hold, say to use Confirm / Mark ready on the Today page. Stock comes from the brand's retail file: the Stock page shows it, and the brand updates it.

LENGTH
- ANSWER: 2–4 sentences. BRIEF ("Today at your store"): 2–3 sentences — what needs doing now (holds waiting, the longest wait), how the period went, and one thing to watch (low stock or missed demand); then next_action.

OUTPUT
One JSON object: answer (the text), handoff_brief (null), next_action ({label ≤ 40 characters, page: one of ${STORE_PAGES.join(', ')}} or null), used (the data sections you relied on, e.g. ["waiting_holds","stock_attention"]).`;

export const StoreAnswerSchema = answerSchemaFor(STORE_PAGES);
export const storeAnswerJsonSchema = (): Record<string, unknown> => jsonSchemaOf(StoreAnswerSchema);

const HINGLISH =
  /\b(kya|kaise|kitne|kitna|hai|hain|mera|meri|mere|dukaan|dukan|aaj|kal|maal|chahiye|batao|bataiye|wala|wali)\b/i;
const pretty = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** The rules "Today at your store": waiting holds first, then the period, then one thing to watch. */
export function quickStoreBrief(pack: StorePack): ModelAnswer {
  const t = pack.totals;
  const w = pack.waiting_holds;
  const live = pack.synthetic_history_included ? '' : ' (live activity only)';
  const parts: string[] = [];
  parts.push(
    w.length
      ? `${plural(w.length, 'hold is', 'holds are')} waiting for you to confirm; the longest has waited ${w[0]!.waited_minutes} min.`
      : 'No holds are waiting for you right now.',
  );
  parts.push(
    `In the last ${pack.period_days} days${live}: ${plural(t.holds, 'hold')}, ${t.picked_up} picked up${t.value_of_pickups ? ` (${money(t.value_of_pickups, t.currency)})` : ''}.`,
  );
  const low = pack.stock_attention.find((s) => s.low);
  const missed = pack.demand_near_you[0];
  if (low) parts.push(`${low.product} is low: ${low.available} left to hold.`);
  else if (missed)
    parts.push(`Shoppers near you asked for ${missed.product} ${plural(missed.count, 'time')} when you couldn't help.`);
  return {
    answer: parts.join(' '),
    handoff_brief: null,
    next_action: w.length ? { label: 'Confirm waiting holds', page: 'TODAY' } : nextOf(pack),
    used: ['waiting_holds', 'totals'],
  };
}

const nextOf = (pack: StorePack): ModelAnswer['next_action'] =>
  pack.stock_attention.length
    ? { label: 'Check your stock', page: 'STOCK' }
    : pack.demand_near_you.length
      ? { label: 'See demand near you', page: 'DEMAND' }
      : null;

const HOLDS = /\b(hold|holds|waiting|wait|confirm|pending|ready|pickup|pick up)\b/i;
const DEMAND = /\b(asking|ask|asked|demand|don'?t have|do not have|missing|missed|shoppers near|chahiye|maang)\b/i;
const STOCK = /\b(stock|restock|stock up|saturday|sunday|weekend|busy|busiest|maal|order more)\b/i;
const DOING = /\b(doing|how did|how is|week|performance|kaisa|kaise|sales|value)\b/i;

/** The rules answer to a store question: the pack sections it is about, in plain sentences (Hinglish when asked so). */
export function quickStoreAnswer(question: string, page: StorePage, pack: StorePack): ModelAnswer {
  const lines: string[] = [];
  const t = pack.totals;
  const hi = HINGLISH.test(question);
  if (HOLDS.test(question)) {
    const w = pack.waiting_holds;
    lines.push(
      w.length
        ? hi
          ? `${w.length} hold aapke confirm ka wait kar rahe hain; sabse purana ${w[0]!.waited_minutes} min se. Today page par Confirm dabaiye.`
          : `${plural(w.length, 'hold is', 'holds are')} waiting for you: ${w
              .slice(0, 3)
              .map((h) => `${h.product} for ${h.customer} (${h.waited_minutes} min)`)
              .join(', ')}. Use Confirm on the Today page.`
        : hi
          ? 'Abhi koi hold aapke confirm ka wait nahi kar raha.'
          : 'No holds are waiting for you right now.',
    );
    if (pack.now.ready_for_pickup)
      lines.push(`${plural(pack.now.ready_for_pickup, 'hold is', 'holds are')} ready for pickup.`);
  }
  if (DEMAND.test(question)) {
    const top = pack.demand_near_you.slice(0, 3);
    lines.push(
      top.length
        ? `Shoppers near you asked for ${top.map((d) => `${d.product} (${plural(d.count, 'time')}, ${pretty(d.reason)})`).join(', ')}.`
        : `No missed demand near you in the last ${pack.period_days} days.`,
    );
  }
  if (STOCK.test(question)) {
    const busy = pack.busiest_weekdays[0];
    if (busy)
      lines.push(
        `Your busiest day is ${busy.weekday}: ${plural(busy.shoppers_nearest, 'shopper')} were nearest to you.`,
      );
    const low = pack.stock_attention.filter((s) => s.low).slice(0, 3);
    if (low.length) lines.push(`Low before then: ${low.map((s) => `${s.product} (${s.available} left)`).join(', ')}.`);
    const missed = pack.demand_near_you.find((d) => d.reason === 'OUT_OF_STOCK');
    if (missed)
      lines.push(`${missed.product} was asked for ${plural(missed.count, 'time')} when you were out of stock.`);
    if (pack.stock_attention.some((s) => s.stale))
      lines.push('Some stock data is out of date; the brand updates it from its retail file.');
  }
  if (DOING.test(question) || lines.length === 0) {
    const live = pack.synthetic_history_included ? '' : ' (live activity only)';
    lines.unshift(
      `In the last ${pack.period_days} days${live}: ${plural(t.holds, 'hold')}, ${t.picked_up} picked up${t.completion_percent !== null ? ` (${t.completion_percent}% of finished holds)` : ''}, ${t.refused} refused and ${t.expired} expired${t.value_of_pickups ? `; pickups worth ${money(t.value_of_pickups, t.currency)}` : ''}.`,
    );
  }
  return {
    answer: [...new Set(lines)].slice(0, 4).join(' '),
    handoff_brief: null,
    next_action:
      HOLDS.test(question) && pack.waiting_holds.length
        ? { label: 'Confirm waiting holds', page: 'TODAY' }
        : page === 'STOCK'
          ? null
          : nextOf(pack),
    used: [],
  };
}
