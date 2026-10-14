import { Router } from 'express';
import type { BrandSettingsQuery } from '../application/brandSettingsQuery.js';
import type { StorefrontOriginsService } from '../application/storefrontOrigins.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

/**
 * GET /api/brand/settings (Change 16, UI-3; docs/06 §14.7): read-only, the principal's own
 * brand only (mounted behind requireScope('BRAND')).
 * PATCH /api/brand/settings/storefront-origins { origins } (L4): the one editable setting — the
 * storefronts allowed to send shopper events. Audited, 10 per minute per brand.
 */
export function brandSettingsRouter(settings: BrandSettingsQuery, origins?: StorefrontOriginsService): Router {
  const router = Router();
  const perBrand = new RateLimiter(10, 60_000);
  router.get('/settings', async (_req, res) => {
    res.json(await settings.get(getBrandPrincipal(res).brandId));
  });
  router.patch('/settings/storefront-origins', async (req, res) => {
    if (!origins) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const principal = getBrandPrincipal(res);
    if (!perBrand.hit(principal.brandId))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
    res.json(await origins.set(principal, (req.body ?? {}) as { origins?: unknown }));
  });
  return router;
}
