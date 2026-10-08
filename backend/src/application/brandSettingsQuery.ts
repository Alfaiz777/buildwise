import { DEFAULT_RADIUS_KM } from './agent/tools.js';
import {
  allowedStorefrontOrigins,
  onlineProductUrl,
  resolveDeliveryDays,
  resolveExtendedRadiusKm,
  resolveFreshnessHours,
  resolveMessagingSettings,
} from '../domain/brandSettings.js';
import { FOLLOW_UP_TYPES, resolveFollowUpSettings } from '../domain/followUpPolicy.js';
import { attributionWindowMs } from '../domain/outcomeRules.js';
import { Errors } from '../lib/errors.js';
import type { BrandRepository } from '../ports/repositories.js';

export type ChannelMode = 'SIMULATOR' | 'WHATSAPP';

/**
 * GET /api/brand/settings (Change 16, UI-3): the brand's settings as the Brand Console's
 * read-only Settings page shows them — resolved through the same functions the backend
 * acts on, so the page shows what actually applies. Only these fields: no credentials,
 * connection secrets, WhatsApp number or user data.
 */
export class BrandSettingsQuery {
  constructor(
    private readonly deps: { brands: BrandRepository; channelMode: ChannelMode; commerceMode?: 'MOCK' | 'SHOPIFY' },
  ) {}

  async get(brandId: string) {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();
    const s = brand.settings;
    const messaging = resolveMessagingSettings(s, brand.name);
    const followUp = resolveFollowUpSettings(s.follow_up_policy);
    return {
      brand_id: brand.brandId,
      messaging: {
        display_name: messaging.displayName,
        logo_url: messaging.logoUrl,
        powered_by_footer: messaging.poweredByFooter,
        handoff_enabled: messaging.handoffEnabled,
      },
      follow_up: {
        inactivity_minutes: followUp.inactivityMinutes,
        frequency_hours: followUp.frequencyHours,
        types: FOLLOW_UP_TYPES.map((type) => ({
          type,
          enabled: followUp.types[type].enabled,
          delay_minutes: followUp.types[type].delayMinutes,
          priority: followUp.types[type].priority,
        })),
      },
      // Judge-test fixes: pickup vs home delivery, and how far a store is still offered after a refusal.
      fulfilment: {
        home_delivery: onlineProductUrl(s, 'x') !== null,
        delivery_days: resolveDeliveryDays(s),
        radius_km: DEFAULT_RADIUS_KM,
        extended_radius_km: resolveExtendedRadiusKm(s, DEFAULT_RADIUS_KM),
      },
      retail_freshness_hours: resolveFreshnessHours(s),
      attribution_window_minutes: Math.round(attributionWindowMs(s) / 60_000),
      allowed_storefront_origins: allowedStorefrontOrigins(s),
      channel: { mode: this.deps.channelMode },
      // L2-Shopify: where the catalogue comes from on this server (the Settings page's Shopify card).
      commerce: { provider: this.deps.commerceMode ?? 'MOCK' },
    };
  }
}
