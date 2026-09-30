import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Server-generated, non-guessable IDs such as `brd_3f9c1a2b7d4e8f60`. */
export function newId(prefix: 'brd' | 'rtl' | 'imp' | 'cus' | 'conv' | 'rec'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

let lastMs = 0;
let sequence = 0;

/**
 * Time-ordered IDs (lexicographic order = creation order), e.g. for conversation messages:
 * milliseconds + a per-process sequence (so two IDs in the same millisecond still sort in
 * creation order) + random bits (so IDs from different instances never collide).
 */
export function sortableId(prefix: 'msg' | 'rec', now: Date = new Date()): string {
  const ms = Math.max(now.getTime(), lastMs);
  sequence = ms === lastMs ? sequence + 1 : 0;
  lastMs = ms;
  return `${prefix}_${ms.toString(36).padStart(9, '0')}${sequence.toString(36).padStart(3, '0')}${randomBytes(4).toString('hex')}`;
}

/** Deterministic ID from a key (idempotent writes); never reversible to the key. */
export function hashedId(prefix: string, key: string, length = 24): string {
  return `${prefix}_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, length)}`;
}

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
