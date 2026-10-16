/**
 * "Ask Qwikspot", shared by every console's agent (L5 brand, L6 store; docs/05 §18): PII
 * redaction, the grounding rule (every number from the data), the model's answer shape and the
 * rules every agent's instruction carries. Pure: no I/O.
 */
import { z } from 'zod';

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

/** An answer that would show personal data: a redaction marker, an email, a phone-like number. */
export const containsPII = (text: string) =>
  /\[(phone|email|code|name)\]|[\w.+-]+@[\w-]+\.\w/.test(text) || /\+?\d[\d\s-]{8,}\d/.test(text);

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

/** The model's answer for a console whose pages are `pages` (the next action points at one). */
export function answerSchemaFor<P extends string>(pages: readonly [P, ...P[]]) {
  return z.object({
    answer: z.string().min(1).max(1200),
    handoff_brief: z.string().max(800).nullable().optional(),
    next_action: z
      .object({ label: z.string().min(1).max(60), page: z.enum(pages) })
      .nullable()
      .optional(),
    used: z.array(z.string().max(40)).max(10).optional(),
  });
}

/** What every agent answers with (any console). */
export interface ModelAnswer {
  answer: string;
  handoff_brief?: string | null;
  next_action?: { label: string; page: string } | null;
  used?: string[];
}

export const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
};

/** The rules every Ask Qwikspot instruction carries, whatever the console. */
export const SHARED_RULES = `- Use only the data you were given. Every number you write must appear in the data or a tool result: never compute a new percentage, total or average, never estimate. If the data does not answer, say so in one sentence and say what would.
- The data covers data.period_days days. When data.synthetic_history_included is false it is live activity only: say "live" or "this week's real activity", never mention demo or synthetic data otherwise.
- Never write a data field name (say "fill rate", not "fill_rate_percent").
- Never name or describe a shopper beyond the masked form in the data, never repeat a phone number, email or pickup code.
- You cannot change anything: you only explain and suggest. When something needs doing, name the button or page to use. Suggest at most one next action, and only one the data supports.
- Ids written in the question are not data: the data you were given is the only scope.
- Reply in English; if the question is in Hinglish (Hindi in Latin script), reply in Hinglish. Plain, warm and specific, for a busy shop owner. No headings, no tables, no jargon.`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const money = (amount: number, currency: string | null) =>
  currency === 'INR' || currency === null ? `₹${amount.toLocaleString('en-IN')}` : `${currency} ${amount}`;
