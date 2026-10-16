/**
 * "Ask Qwikspot" — the brand agent (L5, docs/05 §18): it tells the brand what happened, why,
 * and what to do next, from the brand's own Qwikspot data only. Pure: the data pack types, the
 * grounding check, PII redaction, the model instruction and the rules summaries ("Quick
 * summary") that answer when Gemini is slow, fails or writes a number it was not given.
 */
import { z } from 'zod';

export const CONSOLE_PAGES = ['OVERVIEW', 'CONVERSATIONS', 'RESERVATIONS', 'INSIGHTS', 'NETWORK', 'SETTINGS'] as const;
export type ConsolePage = (typeof CONSOLE_PAGES)[number];

export const PAGE_PATHS: Record<ConsolePage, string> = {
  OVERVIEW: '/brand',
  CONVERSATIONS: '/brand/conversations',
  RESERVATIONS: '/brand/reservations',
  INSIGHTS: '/brand/insights',
  NETWORK: '/brand/network',
  SETTINGS: '/brand/settings',
};

/** Everything the brand agent may know about one brand: computed numbers, store and product names, no shopper. */
export interface BrandPack {
  brand_name: string;
  period_days: number;
  totals: {
    shopper_intents: number;
    conversations: number;
    store_recommendations: number;
    holds: number;
    pickups: number;
    online_orders: number;
    alternative_purchases: number;
    no_purchase: number;
    sales_value: number;
    currency: string | null;
  };
  stores: {
    store_id: string;
    name: string;
    area: string | null;
    status: string;
    has_store_admin: boolean;
    sku_count: number;
    stock_age_hours: number | null;
    nearest_lookups: number;
    had_stock: number;
    fill_pct: number | null;
    refusals: number;
  }[];
  stores_count: number;
  unmet_demand: { product: string; area: string; count: number }[];
  weekday_reading: { kind: string; text: string } | null;
  suggestions: { rule: string; text: string; store_id: string | null }[];
  holds_now: {
    active: number;
    waiting_for_store: number;
    oldest_waiting_minutes: number | null;
    expiring_within_60_min: number;
    by_store: { store: string; waiting: number; confirmed: number; ready: number }[];
  };
  conversations_now: {
    total: number;
    with_hold: number;
    without_hold: number;
    refused_by_store: number;
    with_person: number;
  };
}

/** One conversation, for its summary: the shopper's words (redacted), decisions, the hold. Never the customer. */
export interface ConversationPack {
  product: string | null;
  intent_type: string | null;
  handed_to_person: boolean;
  messages: { from: 'SHOPPER' | 'ASSISTANT' | 'TEAM' | 'STORE' | 'FOLLOW_UP'; text: string }[];
  decisions: { action: string; store: string | null; guardrail: string; reason: string }[];
  holds: { store: string; status: string; cancelled_by: string | null; cancel_reason: string | null }[];
  outcome: string | null;
  message_count: number;
}

const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PICKUP_CODE = /\b\d{6}\b/g;

/** A name the shopper types about themselves: "my name is Priya Shah", "mera naam Priya hai". */
// No `i` flag: with it \p{Lu} matches lowercase too, and "hai" would pass for a surname.
const OWN_NAME = /\b([Mm]y name is|[Mm]y name's|I am called|[Mm]era naam(?: hai)?)\s+\p{L}+(?:\s+\p{Lu}\p{Ll}+)?/gu;

/** Phone numbers, emails, pickup codes and a name the shopper gives never go to the model. */
export const redactPII = (text: string) =>
  text
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]')
    .replace(PICKUP_CODE, '[code]')
    .replace(OWN_NAME, '$1 [name]');

const ISO = /^\d{4}-\d{2}-\d{2}T/;
const ID_LIKE = /^[a-z]+_[\w-]+$/i;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

const toNumber = (raw: string) => Number(raw.replace(/,/g, ''));

/** Every number the data shows: numeric values, and numbers inside texts (not dates or ids). */
export function numbersOf(data: unknown, into = new Set<number>()): Set<number> {
  if (typeof data === 'number') into.add(Math.round(data * 10) / 10);
  else if (typeof data === 'string') {
    if (!ISO.test(data) && !ID_LIKE.test(data)) for (const m of data.match(NUMBER) ?? []) into.add(toNumber(m));
  } else if (Array.isArray(data)) for (const v of data) numbersOf(v, into);
  else if (data && typeof data === 'object') for (const v of Object.values(data)) numbersOf(v, into);
  return into;
}

/**
 * The grounding rule: every number in an AI answer must appear in the data it was given (the
 * pack, a tool result or the question). Returns the numbers that do not.
 */
export function ungroundedNumbers(answer: string, ...sources: unknown[]): number[] {
  const known = new Set<number>();
  for (const s of sources) numbersOf(s, known);
  const found = [...answer.matchAll(NUMBER)].map((m) => toNumber(m[0]));
  return [...new Set(found.filter((n) => !known.has(n) && !known.has(Math.round(n * 10) / 10)))];
}

export const BRAND_ASSISTANT_PROMPT_VERSION = 'ASK_QWIKSPOT_V1';

export const BRAND_ASSISTANT_PROMPT = `You are "Ask Qwikspot", the analyst inside a brand's Qwikspot console. Qwikspot turns shoppers' online intent into store pickups through the brand's WhatsApp. You tell the brand's team what happened, why, and what to do next.

WHAT YOU RECEIVE
One JSON object: task (ANSWER a question, BRIEF for the Overview page, or SUMMARY of one conversation), page (where the team member is), question (for ANSWER), and data: the brand's own data pack (totals for the period, stores, unmet demand, suggestions, holds right now, conversations) or one conversation.

TOOLS (read-only, at most 2 rounds)
- get_store: one store's details and its current holds, by store_id.
- list_conversations: recent conversations with what happened (no shopper details), filtered.
Call a tool only when the pack does not already answer the question.

RULES
- Use only the data you were given. Every number you write must appear in the data or a tool result: never compute a new percentage, total or average, never estimate. If the data does not answer, say so in one sentence and say what would.
- Never name or describe a shopper, never repeat a phone number, email or pickup code.
- You cannot change anything: you only explain and suggest. Suggest at most one next action, and only one the data supports.
- Plain, warm, specific English for a busy shop owner: name the store, the product, the area. No headings, no tables, no jargon ("intent", "guardrail", "funnel" only if they used it).

LENGTH
- ANSWER: 2–4 sentences. BRIEF: 3–4 sentences — what happened this period, the biggest win, the biggest problem, then next_action. SUMMARY: summary in 2 short sentences — what the shopper wanted, what happened and why; handoff_brief (only when the conversation was handed to a person): 2–3 sentences for the person taking over — what they want, what was offered, what is open.

OUTPUT
One JSON object: answer (the text; for SUMMARY the 2-sentence summary), handoff_brief (SUMMARY only, else null), next_action ({label ≤ 40 characters, page: one of ${CONSOLE_PAGES.join(', ')}} or null), used (the data sections you relied on, e.g. ["totals","stores"]).`;

export const BrandAnswerSchema = z.object({
  answer: z.string().min(1).max(1200),
  handoff_brief: z.string().max(800).nullable().optional(),
  next_action: z
    .object({ label: z.string().min(1).max(60), page: z.enum(CONSOLE_PAGES) })
    .nullable()
    .optional(),
  used: z.array(z.string().max(40)).max(10).optional(),
});
export type BrandAnswer = z.infer<typeof BrandAnswerSchema>;

export const brandAnswerJsonSchema = (): Record<string, unknown> => {
  const { $schema: _s, ...schema } = z.toJSONSchema(BrandAnswerSchema) as Record<string, unknown>;
  return schema;
};

const money = (amount: number, currency: string | null) =>
  currency === 'INR' || currency === null ? `₹${amount.toLocaleString('en-IN')}` : `${currency} ${amount}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The rules brief for the Overview page: the same shape as the AI brief, from the pack only. */
export function quickBrief(pack: BrandPack): BrandAnswer {
  const t = pack.totals;
  const parts = [
    `In the last ${pack.period_days} days: ${plural(t.shopper_intents, 'shopper intent')}, ${plural(t.conversations, 'conversation')}, ${plural(t.holds, 'hold')} and ${plural(t.pickups, 'pickup')}${t.sales_value ? ` (${money(t.sales_value, t.currency)})` : ''}.`,
  ];
  const best = [...pack.stores]
    .filter((s) => s.nearest_lookups > 0 && s.fill_pct !== null)
    .sort((a, b) => b.had_stock - a.had_stock || (b.fill_pct ?? 0) - (a.fill_pct ?? 0))[0];
  if (best)
    parts.push(
      `Biggest win: ${best.name} had stock for ${best.had_stock} of ${best.nearest_lookups} shoppers it was nearest to.`,
    );
  const problem = pack.unmet_demand[0];
  if (problem)
    parts.push(
      `Biggest problem: ${problem.product} was asked for ${plural(problem.count, 'time')} in ${problem.area} with no store in stock.`,
    );
  return { answer: parts.join(' '), handoff_brief: null, next_action: nextAction(pack), used: ['totals', 'stores'] };
}

function nextAction(pack: BrandPack): BrandAnswer['next_action'] {
  if (pack.holds_now.waiting_for_store > 0) return { label: 'Check holds waiting on stores', page: 'RESERVATIONS' };
  const s = pack.suggestions[0];
  if (s)
    return s.store_id
      ? { label: 'Open the store', page: 'NETWORK' }
      : { label: 'See the suggestion', page: 'INSIGHTS' };
  if (pack.unmet_demand.length) return { label: 'See unmet demand', page: 'INSIGHTS' };
  return null;
}

const HOLDS = /\b(hold|holds|reservation|reservations|pickup|pick up|waiting|accept|expire)/i;
const STORES = /\b(store|stores|shop|network|admin|stock|restock)\b/i;
const DEMAND = /\b(demand|product|products|losing|asked|restock|saturday|weekday|area|areas)\b/i;
const CHATS = /\b(chat|chats|conversation|conversations|refus\w*|handoff|person)\b/i;

/** The rules answer to a question: the pack sections the question is about, in plain sentences. */
export function quickAnswer(question: string, page: ConsolePage, pack: BrandPack): BrandAnswer {
  const lines: string[] = [];
  const h = pack.holds_now;
  const c = pack.conversations_now;
  if (HOLDS.test(question) || (page === 'RESERVATIONS' && !STORES.test(question))) {
    lines.push(
      `${plural(h.active, 'hold is', 'holds are')} active; ${plural(h.waiting_for_store, 'is', 'are')} waiting for the store to confirm${h.oldest_waiting_minutes !== null ? ` (the oldest for ${h.oldest_waiting_minutes} min)` : ''}, and ${h.expiring_within_60_min} expire within the hour.`,
    );
    const slow = [...h.by_store].sort((a, b) => b.waiting - a.waiting)[0];
    if (slow && slow.waiting > 0) lines.push(`${slow.store} has the most waiting: ${slow.waiting}.`);
  }
  if (STORES.test(question) || page === 'NETWORK') {
    const worst = [...pack.stores]
      .filter((s) => s.fill_pct !== null && s.nearest_lookups > 0)
      .sort((a, b) => (a.fill_pct ?? 0) - (b.fill_pct ?? 0))[0];
    if (worst)
      lines.push(
        `${worst.name} had stock for ${worst.had_stock} of the ${worst.nearest_lookups} shoppers it was nearest to (${worst.fill_pct}%).`,
      );
    const stale = pack.stores.filter((s) => s.stock_age_hours !== null && s.stock_age_hours > 24);
    if (stale.length) lines.push(`Stock data is more than a day old at ${stale.map((s) => s.name).join(', ')}.`);
    const noAdmin = pack.stores.filter((s) => !s.has_store_admin);
    if (noAdmin.length) lines.push(`${plural(noAdmin.length, 'store has', 'stores have')} no Store Admin yet.`);
  }
  if (DEMAND.test(question) || page === 'INSIGHTS') {
    const top = pack.unmet_demand.slice(0, 2);
    for (const u of top)
      lines.push(`${u.product} was asked for ${plural(u.count, 'time')} in ${u.area} with no store in stock.`);
    if (pack.suggestions[0]) lines.push(pack.suggestions[0].text);
  }
  if (CHATS.test(question) || page === 'CONVERSATIONS') {
    lines.push(
      `Of ${plural(c.total, 'conversation')}, ${c.with_hold} led to a hold and ${c.without_hold} did not; stores refused ${plural(c.refused_by_store, 'hold')}, and ${c.with_person} went to a person.`,
    );
  }
  if (!lines.length) return quickBrief(pack);
  return {
    answer: [...new Set(lines)].slice(0, 4).join(' '),
    handoff_brief: null,
    next_action: nextAction(pack),
    used: [],
  };
}

const actionWords: Record<string, string> = {
  STORE_DISCOVERY: 'was shown nearby stores',
  STORE_RESERVATION: 'got a hold',
  ONLINE_PURCHASE: 'was sent the online store',
  ALTERNATIVE_PRODUCT: 'was offered an alternative',
  EDUCATE: 'got product information',
  COMPARE: 'got a comparison',
  HUMAN_HANDOFF: 'asked for a person',
  NO_ACTION: 'chatted',
};

/** The rules summary of one conversation (and the handoff brief, when a person took over). */
export function quickConversationSummary(pack: ConversationPack): BrandAnswer {
  const wanted = pack.product ? `The shopper wanted ${pack.product}` : 'The shopper did not name a product';
  const last = [...pack.decisions].reverse().find((d) => d.action !== 'NO_ACTION') ?? pack.decisions.at(-1);
  const hold = pack.holds.at(-1);
  const happened = hold
    ? `a hold at ${hold.store} is ${hold.status.toLowerCase().replace(/_/g, ' ')}${hold.cancelled_by === 'RETAILER' ? ` (the store refused: ${(hold.cancel_reason ?? '').toLowerCase().replace(/_/g, ' ')})` : ''}`
    : last
      ? `they ${actionWords[last.action] ?? 'chatted'}${last.store ? ` (${last.store})` : ''}`
      : 'nothing has been decided yet';
  const why = last?.reason ? ` ${last.reason}` : '';
  const shopperSaid = [...pack.messages].reverse().find((m) => m.from === 'SHOPPER')?.text;
  return {
    answer: `${wanted}; ${happened}.${why}`.trim(),
    handoff_brief: pack.handed_to_person
      ? `They asked for a person after ${plural(pack.message_count, 'message')}. ${pack.product ? `Product: ${pack.product}. ` : ''}${hold ? `Hold: ${hold.store}, ${hold.status.toLowerCase().replace(/_/g, ' ')}. ` : 'No hold. '}${shopperSaid ? `Their last message: "${shopperSaid.slice(0, 160)}"` : ''}`.trim()
      : null,
    next_action: null,
    used: ['conversation'],
  };
}
