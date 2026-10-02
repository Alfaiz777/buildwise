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

export const prefilledText = (token: string) => `${TOKEN_PREFIX}${token}`;

/** Finds the token in an inbound text and returns the text with it removed. */
export function extractIntentToken(text: string): { token: string | null; text: string } {
  const match = TOKEN_PATTERN.exec(text);
  if (!match) return { token: null, text };
  const cleaned = text.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  return { token: match[1]!, text: cleaned };
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
