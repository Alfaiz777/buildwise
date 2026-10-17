/**
 * "Ask Qwikspot" — the brand agent (L5, docs/05 §18): it tells the brand what happened, why,
 * and what to do next, from the brand's own Qwikspot data only. Pure: the data pack types, the
 * grounding check, PII redaction, the model instruction and the rules summaries ("Quick
 * summary") that answer when Gemini is slow, fails or writes a number it was not given.
 */
import { answerSchemaFor, jsonSchemaOf, money, plural, SHARED_RULES, type ModelAnswer } from './assistant.js';

// The shared grounding helpers, re-exported for the brand agent's callers.
export { numbersOf, redactPII, ungroundedNumbers } from './assistant.js';

export const CONSOLE_PAGES = [
  'OVERVIEW',
  'CONVERSATIONS',
  'RESERVATIONS',
  'SALES',
  'INSIGHTS',
  'NETWORK',
  'SETTINGS',
] as const;
export type ConsolePage = (typeof CONSOLE_PAGES)[number];

export const PAGE_PATHS: Record<ConsolePage, string> = {
  OVERVIEW: '/brand',
  CONVERSATIONS: '/brand/conversations',
  RESERVATIONS: '/brand/reservations',
  SALES: '/brand/sales',
  INSIGHTS: '/brand/insights',
  NETWORK: '/brand/network',
  SETTINGS: '/brand/settings',
};

/** Everything the brand agent may know about one brand: computed numbers, store and product names, no shopper. */
export interface BrandPack {
  brand_name: string;
  period_days: number;
  /** False when the team member hid the synthetic demo history: live activity only. */
  synthetic_history_included: boolean;
  /** The Overview tiles, with the tiles' own definitions. */
  totals: {
    shopper_intents: number;
    new_conversations: number;
    store_recommendations: number;
    holds: number;
    pickups_collected_in_store: number;
    /** Online and alternative-product orders (the "Online orders" tile). */
    online_orders: number;
    purchases: number;
    finished_journeys: number;
    conversion_percent: number | null;
    journeys_without_purchase: number;
    /**
     * Pickups collected in the period that conversion does not count as a purchase: their
     * journey had already finished (closed without a purchase) or finished outside the period.
     * max(0, pickups − store and alternative purchases); usually 0.
     */
    pickups_not_in_conversion: number;
    value_of_purchases: number;
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
    fill_rate_percent: number | null;
    refusals: number;
    /** Holds created in the period that the store confirmed, and the median minutes from created to confirmed (null = none). */
    holds_confirmed: number;
    median_minutes_to_confirm: number | null;
  }[];
  stores_count: number;
  unmet_demand: { product: string; area: string; count: number }[];
  weekday_reading: { kind: string; text: string } | null;
  suggestions: { rule: string; text: string; store_id: string | null }[];
  /**
   * Change 19: the stores' offline sales — walk-in invoices recorded in the Store Console, beside
   * Qwikspot pickups — for the period (live records; walk-in sales have no demo history).
   */
  in_store_sales?: {
    walk_in: { invoices: number; units: number; value: number };
    qwikspot_pickups: { pickups: number; value: number };
    qwikspot_share_percent: number | null;
    by_store: { store: string; walk_in_value: number; invoices: number; pickups: number }[];
    top_products: { product: string; units: number }[];
  } | null;
  holds_now: {
    active: number;
    waiting_for_store: number;
    oldest_waiting_minutes: number | null;
    /** The window of expiring_within_60_min (60): a definition, given as a value so it is grounded. */
    expiry_window_minutes: number;
    expiring_within_60_min: number;
    /** oldest_waiting_minutes: how long the store's oldest unconfirmed hold has waited (null = none waiting). */
    by_store: {
      store: string;
      waiting: number;
      oldest_waiting_minutes: number | null;
      confirmed: number;
      ready: number;
    }[];
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

export const BRAND_ASSISTANT_PROMPT_VERSION = 'ASK_QWIKSPOT_V4'; // V4 (Change 19): in-store sales

export const BRAND_ASSISTANT_PROMPT = `You are "Ask Qwikspot", the analyst inside a brand's Qwikspot console. Qwikspot turns shoppers' online intent into store pickups through the brand's WhatsApp. You tell the brand's team what happened, why, and what to do next.

WHAT YOU RECEIVE
One JSON object: task (ANSWER a question, BRIEF for the Overview page, or SUMMARY of one conversation), page (where the team member is), question (for ANSWER), and data: the brand's own data pack (totals for the period, stores, unmet demand, suggestions, holds right now, conversations) or one conversation.

TOOLS (read-only, offered only when the pack cannot answer; at most 2 rounds)
- get_store: one store's details and its current holds, by store_id.
- list_conversations: the period's conversations, latest first, each with what happened in order (the decisions, the holds and how they ended; no shopper details), filtered.
Call a tool only when the pack does not already answer the question. When no tool is offered, answer from the pack.
- About a particular chat ("the last chat", "that chat"): tell what happened in order from its decisions and holds ("the shopper was offered HealthPlus Chemist, refused it, then…"). If list_conversations returns no conversation, say plainly that no chat matched in this period (for example, "No chat ended without a hold in the last 7 days.").

RULES
${SHARED_RULES}
- in_store_sales are the stores' own invoices for walk-in shoppers (recorded on each store's Sales page) beside Qwikspot pickups; qwikspot_share_percent is the share of that offline value that came through Qwikspot. Walk-in sales are not Qwikspot conversions: never count them in conversion or purchases.
- Use the totals with their meaning: pickups_collected_in_store are pickups, online_orders are online orders, value_of_purchases is the value of purchases, conversion_percent is conversion. Name the store, the product, the area.
- An empty list, a 0 or a null in the data is an answer, not missing data: say what it means. Never say the data "doesn't track" or "doesn't include" something the data has a field for. No holds waiting: "No holds are waiting right now, so no store is behind." median_minutes_to_confirm null: no hold was confirmed there in the period. Say the data does not cover something only when neither the data nor a tool result has it.
- Write percentages with %: "100% fill rate", "conversion 0%". Never write a percentage the data does not have.
- How fast stores accept holds: each store's median_minutes_to_confirm (with holds_confirmed) for the period, and the holds waiting right now with how long the oldest has waited.
- Conversion is the Overview tile's: purchases ÷ finished journeys (a journey finishes with a store pickup, an online order, or closing without a purchase). A collected pickup is a purchase. When pickups_not_in_conversion is above 0, say that many pickups belong to journeys that had already closed without a purchase or finished outside the period, so conversion does not count them.

LENGTH
- ANSWER: 2–4 sentences. BRIEF: 3–4 sentences — what happened this period, the biggest win, the biggest problem, then next_action. SUMMARY: summary in 2 short sentences — what the shopper wanted, what happened and why; handoff_brief (only when the conversation was handed to a person): 2–3 sentences for the person taking over — what they want, what was offered, what is open.

OUTPUT
One JSON object: answer (the text; for SUMMARY the 2-sentence summary), handoff_brief (SUMMARY only, else null), next_action ({label ≤ 40 characters, page: one of ${CONSOLE_PAGES.join(', ')}} or null), used (the data sections you relied on, e.g. ["totals","stores"]).`;

export const BrandAnswerSchema = answerSchemaFor(CONSOLE_PAGES);
export type BrandAnswer = ModelAnswer;

export const brandAnswerJsonSchema = (): Record<string, unknown> => jsonSchemaOf(BrandAnswerSchema);

/** The rules brief for the Overview page: the same shape as the AI brief, from the pack only. */
export function quickBrief(pack: BrandPack): BrandAnswer {
  const t = pack.totals;
  const live = pack.synthetic_history_included ? '' : ' (live activity only)';
  const parts = [
    `In the last ${pack.period_days} days${live}: ${plural(t.shopper_intents, 'shopper intent')}, ${plural(t.new_conversations, 'new conversation')}, ${plural(t.holds, 'hold')}, ${plural(t.pickups_collected_in_store, 'pickup')} and ${plural(t.online_orders, 'online order')}${t.value_of_purchases ? ` (${money(t.value_of_purchases, t.currency)})` : ''}.`,
  ];
  const best = [...pack.stores]
    .filter((s) => s.nearest_lookups > 0 && s.fill_rate_percent !== null)
    .sort((a, b) => b.had_stock - a.had_stock || (b.fill_rate_percent ?? 0) - (a.fill_rate_percent ?? 0))[0];
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
const SLOW = /\b(slow\w*|fast\w*|accept\w*|confirm\w*|behind|quick\w*)\b/i;
const CONVERSION = /\b(conversion|convert\w*)\b/i;

/** "No holds are waiting…", then the slowest median confirm time in the period. */
function acceptLines(pack: BrandPack): string[] {
  const h = pack.holds_now;
  const lines = [
    h.waiting_for_store === 0
      ? 'No holds are waiting right now, so no store is behind.'
      : `${plural(h.waiting_for_store, 'hold is', 'holds are')} waiting for a store to confirm${h.oldest_waiting_minutes !== null ? `; the oldest for ${h.oldest_waiting_minutes} min` : ''}.`,
  ];
  const timed = pack.stores
    .filter((s) => s.median_minutes_to_confirm !== null)
    .sort((a, b) => (b.median_minutes_to_confirm ?? 0) - (a.median_minutes_to_confirm ?? 0));
  if (timed.length)
    lines.push(
      `In the last ${pack.period_days} days the slowest to confirm was ${timed[0]!.name}: a median of ${timed[0]!.median_minutes_to_confirm} min over ${plural(timed[0]!.holds_confirmed, 'hold')}.`,
    );
  else lines.push(`No store confirmed a hold in the last ${pack.period_days} days.`);
  return lines;
}

/** Conversion in words, with the Overview tile's definition and any pickups it does not count. */
function conversionLine(pack: BrandPack): string {
  const t = pack.totals;
  const base =
    t.conversion_percent === null
      ? 'No journey has finished yet in this period, so there is no conversion.'
      : `Conversion is ${t.conversion_percent}%: ${t.purchases} of ${plural(t.finished_journeys, 'finished journey')} ended in a purchase.`;
  return t.pickups_not_in_conversion > 0
    ? `${base} ${plural(t.pickups_not_in_conversion, 'pickup belongs', 'pickups belong')} to a journey that had already closed without a purchase or finished outside the period, so conversion does not count it.`
    : base;
}

/** The rules answer to a question: the pack sections the question is about, in plain sentences. */
/** A question asking to see particular chats (not their counts, which the pack has). */
const CHAT_LIST =
  /\b(show|list|find|open|see|give|dikhao|batao)\b[^?]*\b(chats?|conversations?)\b|\b(which|kaun ?se)\s+(chats?|conversations?)\b/i;
/** One particular or recent chat: "the last chat", "that conversation", "aakhri chat", "kaunsi chat". */
const CHAT_PARTICULAR =
  /\b(last|latest|recent|most recent|previous|that|aakhri|akhri|pichli|kaunsi|kaunsa)\s+(chats?|conversations?)\b/i;
/** Why or how one chat ended: "why did the chat end", "how did that conversation go", "chat kyun khatam hui". */
const CHAT_WHY =
  /\b(why|how|kyun|kyon)\b[^?]*\b(the|a|that|this|one)\s+(chat|conversation)\b(?!s)|\b(chat|conversation)\b[^?]*\b(kyun|kyon)\b/i;
const HOLD_WORDS = /\b(holds?|reservations?|orders?|pickups?)\b/i;

/**
 * The read tools a brand question needs; none when the pack already answers it — then Gemini
 * answers in one call. Particular chats need list_conversations; one named store's holds (their
 * products and ages) need get_store. Everything else — totals, stores, demand, holds right now,
 * conversation counts — is in the pack.
 */
export function brandToolsFor(question: string, pack: BrandPack): string[] {
  const tools: string[] = [];
  if (CHAT_LIST.test(question) || CHAT_PARTICULAR.test(question) || CHAT_WHY.test(question))
    tools.push('list_conversations');
  const q = question.toLowerCase();
  if (HOLD_WORDS.test(question) && pack.stores.some((s) => q.includes(s.name.toLowerCase()))) tools.push('get_store');
  return tools;
}

export function quickAnswer(question: string, page: ConsolePage, pack: BrandPack): BrandAnswer {
  const lines: string[] = [];
  const h = pack.holds_now;
  const c = pack.conversations_now;
  const accept = SLOW.test(question) && (HOLDS.test(question) || STORES.test(question));
  const conversion = CONVERSION.test(question);
  if (conversion) lines.push(conversionLine(pack));
  if (accept) lines.push(...acceptLines(pack));
  else if (!conversion && (HOLDS.test(question) || (page === 'RESERVATIONS' && !STORES.test(question)))) {
    lines.push(
      `${plural(h.active, 'hold is', 'holds are')} active; ${plural(h.waiting_for_store, 'is', 'are')} waiting for the store to confirm${h.oldest_waiting_minutes !== null ? ` (the oldest for ${h.oldest_waiting_minutes} min)` : ''}, and ${h.expiring_within_60_min} expire within the hour.`,
    );
    const slow = [...h.by_store].sort((a, b) => b.waiting - a.waiting)[0];
    if (slow && slow.waiting > 0) lines.push(`${slow.store} has the most waiting: ${slow.waiting}.`);
  }
  if (!accept && (STORES.test(question) || page === 'NETWORK')) {
    const worst = [...pack.stores]
      .filter((s) => s.fill_rate_percent !== null && s.nearest_lookups > 0)
      .sort((a, b) => (a.fill_rate_percent ?? 0) - (b.fill_rate_percent ?? 0))[0];
    if (worst)
      lines.push(
        `${worst.name} had stock for ${worst.had_stock} of the ${worst.nearest_lookups} shoppers it was nearest to (${worst.fill_rate_percent}%).`,
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

const lower = (s: string) => s.toLowerCase().replace(/_/g, ' ');
/** What each decision offered, as the handoff brief lists it. */
const TRIED: Record<string, string> = {
  STORE_DISCOVERY: 'nearby stores shown',
  STORE_RESERVATION: 'a hold offered',
  ONLINE_PURCHASE: 'the online store link',
  ALTERNATIVE_PRODUCT: 'an alternative offered',
  EDUCATE: 'product details',
  COMPARE: 'a comparison',
};

/**
 * The rules handoff brief (L9): 2 lines for the person taking over — what the shopper wants and
 * what was already tried (stores shown, holds and how they ended). Never the shopper's own
 * words, so no name or phone number can appear.
 */
function quickHandoffBrief(pack: ConversationPack): string {
  const wants = pack.product
    ? `Wants ${pack.product}; asked for a person after ${plural(pack.message_count, 'message')}.`
    : `Asked for a person after ${plural(pack.message_count, 'message')}, without naming a product.`;
  const tried = new Set<string>();
  for (const d of pack.decisions) {
    if (d.action === 'NO_ACTION' || d.action === 'HUMAN_HANDOFF') continue;
    tried.add(`${TRIED[d.action] ?? lower(d.action)}${d.store ? ` (${d.store})` : ''}`);
  }
  for (const h of pack.holds)
    tried.add(
      `a hold at ${h.store}, ${lower(h.status)}${h.cancelled_by === 'RETAILER' ? ` (the store refused: ${lower(h.cancel_reason ?? 'other')})` : ''}`,
    );
  const list = [...tried].slice(0, 4);
  return `${wants}\nAlready tried: ${list.length ? list.join('; ') : 'nothing yet'}.`;
}

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
  return {
    answer: `${wanted}; ${happened}.${why}`.trim(),
    handoff_brief: pack.handed_to_person ? quickHandoffBrief(pack) : null,
    next_action: null,
    used: ['conversation'],
  };
}
