/**
 * Shopify OAuth and webhook checks (L2-Shopify; docs/06 §9, §17.1 "S1 Shopify"). Pure:
 * no network, no storage. Every comparison is timing-safe.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A shop's permanent domain; anchored so "x.myshopify.com.evil.example" never passes. */
export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Lower-cases and validates a shop domain; null when it is not a myshopify.com domain. */
export function normalizeShopDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const shop = raw.trim().toLowerCase();
  return shop.length <= 255 && SHOP_DOMAIN.test(shop) ? shop : null;
}

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * The OAuth callback's `hmac`: every other query parameter, sorted, joined as key=value
 * with "&", HMAC-SHA256 with the app's client secret, hex.
 */
export function verifyCallbackHmac(query: Record<string, string>, secret: string): boolean {
  const given = query.hmac;
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given.toLowerCase(), 'utf8'));
}

/** Webhooks: X-Shopify-Hmac-Sha256 is base64(HMAC-SHA256(raw body, client secret)). */
export function verifyWebhookHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  return safeEqual(expected, given);
}

/** The signed OAuth `state`: binds the brand, the user, the shop and a single-use nonce. */
export interface OAuthState {
  nonce: string;
  brandId: string;
  userId: string;
  shop: string;
  /** epoch ms */
  exp: number;
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function signState(state: OAuthState, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ n: state.nonce, b: state.brandId, u: state.userId, s: state.shop, e: state.exp }),
  ).toString('base64url');
  return `${payload}.${sign(`state.${payload}`, secret)}`;
}

export type StateCheck = { ok: true; state: OAuthState } | { ok: false; reason: 'INVALID_STATE' | 'STATE_EXPIRED' };

/** Signature and expiry only; single use is enforced by the caller's nonce store. */
export function readState(token: unknown, secret: string, now: number): StateCheck {
  if (typeof token !== 'string' || token.length > 1024) return { ok: false, reason: 'INVALID_STATE' };
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return { ok: false, reason: 'INVALID_STATE' };
  if (!safeEqual(Buffer.from(sign(`state.${payload}`, secret)), Buffer.from(mac))) {
    return { ok: false, reason: 'INVALID_STATE' };
  }
  let raw: { n?: unknown; b?: unknown; u?: unknown; s?: unknown; e?: unknown };
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'INVALID_STATE' };
  }
  const { n, b, u, s, e } = raw;
  if (typeof n !== 'string' || typeof b !== 'string' || typeof u !== 'string' || typeof s !== 'string')
    return { ok: false, reason: 'INVALID_STATE' };
  if (typeof e !== 'number' || now > e) return { ok: false, reason: 'STATE_EXPIRED' };
  return { ok: true, state: { nonce: n, brandId: b, userId: u, shop: s, exp: e } };
}
