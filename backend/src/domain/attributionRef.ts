/**
 * AttributionRef (`bw_ref`, docs/00 §11.8 Change 13, F6): an opaque random reference added
 * to "Buy online" links. 128 random bits in Crockford Base32; only its SHA-256 is stored.
 * It only LINKS an order to a journey — the purchase evidence is the order itself.
 */
import { randomBytes } from 'node:crypto';
import { encodeIntentToken, hashIntentToken } from './intentToken.js';

export const ATTRIBUTION_REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const newAttributionRef = (bytes: Uint8Array = randomBytes(16)) => encodeIntentToken(bytes);
export const hashAttributionRef = (ref: string) => hashIntentToken(ref);

export type AttributionRejection = 'MALFORMED' | 'UNKNOWN' | 'WRONG_BRAND' | 'EXPIRED';

export function checkAttributionRef(
  stored: { brandId: string; expiresAt: string } | null,
  brandId: string,
  now: Date,
): AttributionRejection | null {
  if (!stored) return 'UNKNOWN';
  if (stored.brandId !== brandId) return 'WRONG_BRAND';
  if (now.getTime() >= new Date(stored.expiresAt).getTime()) return 'EXPIRED';
  return null;
}

/** Adds bw_ref to the query string, before any #fragment, keeping existing parameters. */
export function withAttributionRef(url: string, ref: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const cleaned = base.replace(/([?&])bw_ref=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return `${cleaned}${cleaned.includes('?') ? '&' : '?'}bw_ref=${ref}${fragment}`;
}

/** Decorates every link in a reply that points at the brand's online store (prefix match). */
export function decorateOnlineLinks(text: string, onlinePrefix: string, ref: string): string {
  return text.replace(/https?:\/\/\S+/g, (url) => (url.startsWith(onlinePrefix) ? withAttributionRef(url, ref) : url));
}

/** The fixed part of `online_store.product_url_template` (everything before `{product_id}`). */
export function onlinePrefixOf(settings: Record<string, unknown>): string | null {
  const raw = settings.online_store;
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).product_url_template : null;
  if (typeof t !== 'string' || !t.includes('{product_id}')) return null;
  const prefix = t.slice(0, t.indexOf('{product_id}'));
  return /^https?:\/\//.test(prefix) ? prefix.split('#')[0]!.split('?')[0]! : null;
}
