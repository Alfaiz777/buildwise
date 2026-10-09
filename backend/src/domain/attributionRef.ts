/**
 * AttributionRef (`qs_ref`, docs/00 §11.8 Change 13, F6): an opaque random reference added
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

/** Adds qs_ref to the query string, before any #fragment, keeping existing parameters. */
export function withAttributionRef(url: string, ref: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const cleaned = base.replace(/([?&])qs_ref=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return `${cleaned}${cleaned.includes('?') ? '&' : '?'}qs_ref=${ref}${fragment}`;
}

/** The cart attribute Shopify copies onto the order's `note_attributes` (read by orders/create). */
const CART_ATTRIBUTE = 'attributes%5Bqs_ref%5D';

/**
 * Adds qs_ref to a Shopify cart permalink as the cart attribute `attributes[qs_ref]`. Shopify
 * keeps cart attributes on the order; a plain `?qs_ref=` parameter would be dropped at the cart.
 */
export function withShopifyCartAttribute(url: string, ref: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const cleaned = base.replace(/([?&])attributes(?:%5B|\[)qs_ref(?:%5D|\])=[^&]*&?/i, '$1').replace(/[?&]$/, '');
  return `${cleaned}${cleaned.includes('?') ? '&' : '?'}${CART_ATTRIBUTE}=${ref}${fragment}`;
}

/** Where a brand's "Buy online" links point: its storefront template and/or its connected Shopify store. */
export interface OnlineLinkTargets {
  /** onlinePrefixOf(brand settings), or null. */
  storefrontPrefix: string | null;
  /** The connected Shopify store's myshopify.com domain, or null. */
  shopifyShop: string | null;
}

const shopifyCartPrefix = (shop: string) => `https://${shop}/cart/`;

/** Decorates one link: a Shopify cart permalink gets the cart attribute, a storefront link the query parameter. */
function decorateLink(url: string, targets: OnlineLinkTargets, ref: string): string {
  if (targets.shopifyShop && url.startsWith(shopifyCartPrefix(targets.shopifyShop)))
    return withShopifyCartAttribute(url, ref);
  if (targets.storefrontPrefix && url.startsWith(targets.storefrontPrefix)) return withAttributionRef(url, ref);
  return url;
}

/** True when the text holds at least one link to the brand's online store. */
export function linksToOnlineStore(text: string, targets: OnlineLinkTargets): boolean {
  return (text.match(/https?:\/\/\S+/g) ?? []).some((url) => decorateLink(url, targets, 'x') !== url);
}

/** Decorates every link in a reply that points at the brand's online store (prefix match). */
export function decorateOnlineLinks(text: string, targets: OnlineLinkTargets, ref: string): string {
  return text.replace(/https?:\/\/\S+/g, (url) => decorateLink(url, targets, ref));
}

/** The fixed part of `online_store.product_url_template` (everything before `{product_id}`). */
export function onlinePrefixOf(settings: Record<string, unknown>): string | null {
  const raw = settings.online_store;
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).product_url_template : null;
  if (typeof t !== 'string' || !t.includes('{product_id}')) return null;
  const prefix = t.slice(0, t.indexOf('{product_id}'));
  return /^https?:\/\//.test(prefix) ? prefix.split('#')[0]!.split('?')[0]! : null;
}
