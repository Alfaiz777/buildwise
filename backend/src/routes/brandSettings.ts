import { Router } from 'express';
import type { BrandSettingsQuery } from '../application/brandSettingsQuery.js';
import { getBrandPrincipal } from '../auth/authorize.js';

/**
 * GET /api/brand/settings (Change 16, UI-3; docs/06 §14.7): read-only, the principal's own
 * brand only (mounted behind requireScope('BRAND')). No write route exists.
 */
export function brandSettingsRouter(settings: BrandSettingsQuery): Router {
  const router = Router();
  router.get('/settings', async (_req, res) => {
    res.json(await settings.get(getBrandPrincipal(res).brandId));
  });
  return router;
}
