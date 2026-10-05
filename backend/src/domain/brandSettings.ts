/**
 * Typed views over brand.settings (docs/04_DATA_MODEL.md §3). Unknown or malformed
 * values fall back to safe defaults; nothing here trusts client input.
 */

export interface BrandMessagingSettings {
  /** The sender name customers see ("Demo Beauty Co"), never "Qwikspot". */
  displayName: string;
  /** The brand's WhatsApp number (digits only; placeholder locally). */
  whatsappNumber: string | null;
  handoffEnabled: boolean;
  /** "Powered by Qwikspot" on automated interactive messages (Change 16); default on. */
  poweredByFooter: boolean;
  /** The brand's logo for the chat header (path or https URL), or null. */
  logoUrl: string | null;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function resolveMessagingSettings(settings: Record<string, unknown>, brandName: string): BrandMessagingSettings {
  const messaging = record(settings.messaging);
  const handoff = record(settings.human_handoff_rules);
  const displayName =
    typeof messaging.display_name === 'string' && messaging.display_name.trim()
      ? messaging.display_name.trim()
      : brandName;
  const number = typeof messaging.whatsapp_number === 'string' ? messaging.whatsapp_number.replace(/\D/g, '') : '';
  return {
    displayName: displayName.slice(0, 60),
    whatsappNumber: number || null,
    handoffEnabled: handoff.enabled !== false,
    poweredByFooter: messaging.powered_by_footer !== false,
    logoUrl:
      typeof messaging.logo_url === 'string' && /^(https:\/\/|\/)[^\s]+$/.test(messaging.logo_url)
        ? messaging.logo_url
        : null,
  };
}

export const DEFAULT_RETAIL_FRESHNESS_HOURS = 24;

/** brand.settings.retail_freshness_hours (Change 14, G1): how old stock may be before it is called out. */
export function resolveFreshnessHours(settings: Record<string, unknown>): number {
  const h = settings.retail_freshness_hours;
  return typeof h === 'number' && h > 0 && h <= 24 * 30 ? h : DEFAULT_RETAIL_FRESHNESS_HOURS;
}

/** True when the stock row is older than the freshness window (or has no timestamp at all). */
export function isStockStale(lastUpdatedAt: string | null, now: Date, freshnessHours: number): boolean {
  if (!lastUpdatedAt) return true;
  return now.getTime() - new Date(lastUpdatedAt).getTime() > freshnessHours * 60 * 60_000;
}

/** brand.settings.allowed_storefront_origins, exact origin strings only. */
export function allowedStorefrontOrigins(settings: Record<string, unknown>): string[] {
  const list = settings.allowed_storefront_origins;
  return Array.isArray(list) ? list.filter((o): o is string => typeof o === 'string') : [];
}

/** brand.settings.online_store.product_url_template → the "Buy online" link (Change 12, E10). */
export function onlineProductUrl(settings: Record<string, unknown>, productId: string): string | null {
  const template = record(settings.online_store).product_url_template;
  if (typeof template !== 'string' || !/^https?:\/\//.test(template) || !template.includes('{product_id}')) return null;
  return template.replace('{product_id}', encodeURIComponent(productId));
}

export const DEFAULT_DELIVERY_DAYS = '4–5';

/**
 * brand.settings.online_store.delivery_days: how long home delivery takes, shown next to
 * "Pick up today" ("4–5" or "3"). Anything else falls back to the default.
 */
export function resolveDeliveryDays(settings: Record<string, unknown>): string {
  const days = record(settings.online_store).delivery_days;
  if (typeof days !== 'string') return DEFAULT_DELIVERY_DAYS;
  const m = /^\s*(\d{1,2})\s*(?:[-–]\s*(\d{1,2}))?\s*$/.exec(days);
  return m ? (m[2] ? `${m[1]}–${m[2]}` : m[1]!) : DEFAULT_DELIVERY_DAYS;
}

/** "Home delivery in 4–5 days" / "in 1 day". */
export const deliveryPhrase = (days: string) => `${days} ${days === '1' ? 'day' : 'days'}`;

export const DEFAULT_EXTENDED_RADIUS_KM = 25;

/**
 * brand.settings.reservation_policy.extended_radius_km: after a store refuses and no other
 * store is within the normal radius, the nearest store within this distance is still offered
 * (with its distance). At most 25 km (the store search's own limit); never below the normal radius.
 */
export function resolveExtendedRadiusKm(settings: Record<string, unknown>, normalRadiusKm: number): number {
  const km = record(settings.reservation_policy).extended_radius_km;
  const value = typeof km === 'number' && km > 0 && km <= 25 ? km : DEFAULT_EXTENDED_RADIUS_KM;
  return Math.max(value, normalRadiusKm);
}
