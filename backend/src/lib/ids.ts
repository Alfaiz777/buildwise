import { randomUUID } from 'node:crypto';

/** Server-generated, non-guessable IDs such as `brd_3f9c1a2b7d4e8f60`. */
export function newId(prefix: 'brd' | 'rtl'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
