/**
 * Web → WhatsApp handshake token (docs/06_INTEGRATION_CONTRACTS.md §10.1,
 * docs/07_SECURITY_SPEC.md §18): START_QWIKSPOT_<INTENT_TOKEN>, where the token is a
 * 128-bit random value in Crockford Base32 (26 chars). Only its SHA-256 hash is stored.
 */
import { createHash } from 'node:crypto';

export const TOKEN_PREFIX = 'START_QWIKSPOT_';
export const TOKEN_TTL_MS = 30 * 60 * 1000;
export const MAX_TOKENS_PER_SESSION_PER_HOUR = 5;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Detection anywhere in the first inbound text (docs/06 §10.1). */
export const TOKEN_PATTERN = /START_QWIKSPOT_([0-9A-HJKMNP-TV-Z]{26})/;

/** 16 random bytes → 26 Crockford Base32 characters (128 bits, left-padded to 130). */
export function encodeIntentToken(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('An intent token needs exactly 16 random bytes');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export const hashIntentToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** The token as it appears in a message: START_QWIKSPOT_<token>. */
export const prefilledText = (token: string) => `${TOKEN_PREFIX}${token}`;

/** "(ref START_QWIKSPOT_<token>)" — how the readable prefilled message carries the token. */
export const intentRef = (token: string) => `(ref ${prefilledText(token)})`;

/** The readable message's longest parts, so the whole stays around 200 characters. */
const MAX_BRAND = 30;
const MAX_PRODUCT = 45;
const MAX_SIZE = 15;

const clip = (value: string, max: number) => {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/**
 * The prefilled WhatsApp message (docs/06 §10.1), built only from verified data: the brand's
 * display name, the intent's product and size (catalogue), the entry the shopper tapped — then
 * the token, as " (ref START_QWIKSPOT_<token>)". No customer data is ever part of it.
 *   STORE_NEED: "Hi AquaSkin! I'd like Mineral Sunscreen SPF 50 (50 g) today. Is it available at a store near me?"
 *   CHAT:       "Hi AquaSkin! I have a question about Mineral Sunscreen SPF 50 (50 g)."
 *   no product: "Hi AquaSkin! I'd like some help choosing a product."
 */
export function readablePrefilledText(input: {
  brandName: string;
  productTitle: string | null;
  size: string | null;
  entry: 'STORE_NEED' | 'CHAT';
  token: string;
}): string {
  return `${readableMessage(input)} ${intentRef(input.token)}`;
}

/**
 * L4 (plain prefill): the sentence alone — what the shopper now sees in WhatsApp. The chat is
 * linked by recognising this exact sentence (prefillTextHash), not by a visible code.
 */
export function readableMessage(input: {
  brandName: string;
  productTitle: string | null;
  size: string | null;
  entry: 'STORE_NEED' | 'CHAT';
}): string {
  const brand = clip(input.brandName, MAX_BRAND);
  const hi = brand ? `Hi ${brand}!` : 'Hi!';
  const product = input.productTitle
    ? `${clip(input.productTitle, MAX_PRODUCT)}${input.size ? ` (${clip(input.size, MAX_SIZE)})` : ''}`
    : null;
  const body = !product
    ? `${hi} I'd like some help choosing a product.`
    : input.entry === 'STORE_NEED'
      ? `${hi} I'd like ${product} today. Is it available at a store near me?`
      : `${hi} I have a question about ${product}.`;
  return body;
}

/** A prefilled sentence is long; anything shorter is never matched by text. */
export const MIN_PREFILL_MATCH_LENGTH = 20;

/**
 * The prefilled sentence in the form it is compared in: lower-case, curly quotes made straight,
 * whitespace collapsed, trailing punctuation and spaces removed. WhatsApp may add or drop a
 * trailing space or full stop; any other change means the shopper edited the message.
 */
export function normalizePrefillText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!?…,;:]+$/u, '');
}

/** What is stored on the token record and looked up: a hash, never the text itself. */
export const prefillTextHash = (text: string) =>
  createHash('sha256')
    .update(`prefill:${normalizePrefillText(text)}`, 'utf8')
    .digest('hex');

/** Two identical sentences within 30 minutes: the newest binds only if it is this recent. */
export const PREFILL_AMBIGUITY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Which open token a matching sentence binds: the only one; of several, the newest if it was
 * issued within the last 2 minutes (it is almost certainly this shopper's); otherwise none.
 */
export function pickPrefillMatch<T extends { issuedAt: string }>(open: T[], now: Date): T | null {
  if (open.length === 0) return null;
  if (open.length === 1) return open[0]!;
  const newest = [...open].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0]!;
  return now.getTime() - new Date(newest.issuedAt).getTime() <= PREFILL_AMBIGUITY_WINDOW_MS ? newest : null;
}

/** "(ref START_QWIKSPOT_<token>)", or the bare token, anywhere in the text. */
const WRAPPED_TOKEN = new RegExp(`\\(\\s*ref\\s*:?\\s*${TOKEN_PATTERN.source}\\s*\\)`, 'i');
/** What is left of "(ref …)" if the shopper edited the token away. */
const EMPTY_REF = /\(\s*ref\s*:?\s*\)/gi;
const HAS_EMPTY_REF = /\(\s*ref\s*:?\s*\)/i;

/**
 * Finds the token in an inbound text and returns the text with it removed — together with
 * its "(ref …)" wrapper, so the agent sees only the shopper's words.
 */
export function extractIntentToken(text: string): { token: string | null; text: string } {
  const match = WRAPPED_TOKEN.exec(text) ?? TOKEN_PATTERN.exec(text);
  const tidy = (t: string) => t.replace(EMPTY_REF, ' ').replace(/\s+/g, ' ').trim();
  if (!match) return { token: null, text: HAS_EMPTY_REF.test(text) ? tidy(text) : text };
  return { token: match[1]!, text: tidy(text.replace(match[0], ' ')) };
}

export type TokenRejection = 'TOKEN_UNKNOWN' | 'TOKEN_WRONG_BRAND' | 'TOKEN_EXPIRED' | 'TOKEN_ALREADY_USED';

/** Validation inside the consume transaction (docs/06 §10.1). */
export function checkIntentToken(
  token: { brandId: string; expiresAt: string; consumedAt: string | null } | null,
  brandId: string,
  now: Date,
): TokenRejection | null {
  if (!token) return 'TOKEN_UNKNOWN';
  if (token.brandId !== brandId) return 'TOKEN_WRONG_BRAND';
  if (now.getTime() >= new Date(token.expiresAt).getTime()) return 'TOKEN_EXPIRED';
  if (token.consumedAt) return 'TOKEN_ALREADY_USED';
  return null;
}
