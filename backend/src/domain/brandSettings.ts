/**
 * Typed views over brand.settings (docs/04_DATA_MODEL.md §3). Unknown or malformed
 * values fall back to safe defaults; nothing here trusts client input.
 */

export interface BrandMessagingSettings {
  /** The sender name customers see ("Demo Beauty Co"), never "Buildwise". */
  displayName: string;
  /** The brand's WhatsApp number (digits only; placeholder locally). */
  whatsappNumber: string | null;
  handoffEnabled: boolean;
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
