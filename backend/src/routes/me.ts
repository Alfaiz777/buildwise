import { Router } from 'express';
import { getPrincipal } from '../auth/authorize.js';

/** GET /api/me — who the backend believes the caller is. Any authenticated role. */
export function meRouter(): Router {
  const router = Router();
  router.get('/me', (_req, res) => {
    const principal = getPrincipal(res);
    const brand = res.locals.brand;
    res.json({
      user: {
        user_id: principal.userId,
        email: principal.email,
        role: principal.role,
        store_ids: principal.storeIds,
      },
      brand: brand ? { brand_id: brand.brandId, name: brand.name } : null,
    });
  });
  return router;
}
