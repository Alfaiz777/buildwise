import type { BrandPrincipal } from '../domain/principal.js';
import { parseStorefrontOrigins } from '../domain/brandSettings.js';
import { AppError, Errors } from '../lib/errors.js';
import type { AuditRepository, BrandRepository } from '../ports/repositories.js';

/**
 * Brand Console → Settings → "Storefronts allowed to send shopper events" (L4): the brand's
 * own Brand Admin edits allowed_storefront_origins — the storefronts (e.g. the brand's Shopify
 * store) whose POST /api/intents calls are accepted. Exact origins only, https (or a localhost
 * dev origin); audited. Reset demo keeps this list (application/demoSetup.ts).
 */
export class StorefrontOriginsService {
  constructor(private readonly deps: { brands: BrandRepository; audit: AuditRepository }) {}

  async set(principal: BrandPrincipal, body: { origins?: unknown }): Promise<{ allowed_storefront_origins: string[] }> {
    const origins = parseStorefrontOrigins(body.origins);
    if (!origins) {
      throw new AppError(
        400,
        'INVALID_STOREFRONT_ORIGINS',
        'Use up to 10 storefront addresses like https://your-store.myshopify.com (no path).',
      );
    }
    const brand = await this.deps.brands.getById(principal.brandId);
    if (!brand) throw Errors.notFound();
    await this.deps.brands.setAllowedStorefrontOrigins(principal.brandId, origins);
    await this.deps.audit.recordBrandEvent({
      brandId: principal.brandId,
      actorType: 'USER',
      actorId: principal.userId,
      action: 'STOREFRONT_ORIGINS_UPDATED',
      targetType: 'BRAND',
      targetId: principal.brandId,
      result: 'SUCCESS',
      reasonCode: `count=${origins.length}`,
    });
    return { allowed_storefront_origins: origins };
  }
}
