import { Router, type Request } from 'express';
import type { DemoResetService } from '../application/demoResetService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import type { DemoConfig } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

/**
 * GET /api/demo/config (public; docs/00 §11.8 Change 14, G3). With DEMO_MODE on it returns
 * the demo logins from CONFIGURATION (never compiled into the frontend bundle); with it off
 * it returns only { demo_mode: false }. Rate limited per IP.
 */
export function demoRouter(demo: DemoConfig | undefined): Router {
  const router = Router();
  const perIp = new RateLimiter(30, 60_000);
  router.get('/demo/config', (req: Request, res) => {
    if (!perIp.hit(req.ip ?? 'unknown'))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.', true);
    if (!demo?.enabled) {
      res.json({ demo_mode: false });
      return;
    }
    res.json({
      demo_mode: true,
      logins: demo.logins.map((l) => ({
        email: l.email,
        password: l.password,
        role: l.role,
        title: l.title,
        hint: l.hint,
      })),
    });
  });
  return router;
}

/**
 * /api/brand/demo (BRAND_ADMIN; Change 14, G4). GET says whether Reset demo is offered to
 * this brand; POST resets it — DEMO_MODE off → 404, not an allowlisted demo brand → 403,
 * at most once per minute per brand → 429. Audited as DEMO_RESET.
 */
export function brandDemoRouter(demoReset: DemoResetService): Router {
  const router = Router();
  const perBrand = new RateLimiter(1, 60_000);

  router.get('/demo', (_req, res) => {
    const principal = getBrandPrincipal(res);
    res.json({ reset_available: demoReset.availableFor(principal.brandId) });
  });

  router.post('/demo/reset', async (_req, res) => {
    const principal = getBrandPrincipal(res);
    const actor = { type: 'USER' as const, id: principal.userId };
    if (!demoReset.availableFor(principal.brandId)) {
      await demoReset.reset(principal.brandId, actor); // throws the right 404 / 403
      return;
    }
    if (!perBrand.hit(principal.brandId)) {
      throw new AppError(429, 'RATE_LIMITED', 'The demo was just reset. Try again in a minute.', true);
    }
    const r = await demoReset.reset(principal.brandId, actor);
    res.json({
      brand_id: r.brandId,
      deleted: r.deleted,
      catalog: r.catalog,
      stock: { status: r.stock.status, rows_valid: r.stock.rowsValid, rows_invalid: r.stock.rowsInvalid },
      history: r.history,
    });
  });

  return router;
}
