import { Router } from 'express';
import { z } from 'zod';
import type { InsightsService } from '../application/insightsService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { Errors } from '../lib/errors.js';

const Query = z.object({
  days: z.enum(['7', '28']).default('7'),
  include_history: z.enum(['true', 'false']).default('true'),
});

/**
 * GET /api/brand/insights (docs/06 §14.7, M6): the Outcomes & insights panels for the
 * principal's own brand only (mounted behind requireScope('BRAND')).
 */
export function insightsRouter(insights: InsightsService): Router {
  const router = Router();
  router.get('/insights', async (req, res) => {
    const q = Query.safeParse(req.query);
    if (!q.success) throw Errors.invalidRequest('Period must be 7 or 28 days.');
    res.json(
      await insights.panels(getBrandPrincipal(res).brandId, {
        days: Number(q.data.days) as 7 | 28,
        includeHistory: q.data.include_history === 'true',
      }),
    );
  });
  return router;
}
