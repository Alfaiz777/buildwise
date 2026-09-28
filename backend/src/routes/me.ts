import { Router } from 'express';
import { getPrincipal } from '../auth/authorize.js';
import type { StoreRecord } from '../ports/repositories.js';

/** Store identity/location/status/hours as shown to its RETAIL_ADMIN. */
export const storeJson = (s: StoreRecord) => ({
  store_id: s.storeId,
  store_name: s.storeName,
  city: s.city,
  address: s.address,
  store_status: s.storeStatus,
  store_hours: s.storeHours,
});

/**
 * GET /api/me — who the backend believes the caller is, and in which scope
 * (docs/06_INTEGRATION_CONTRACTS.md §14.8). Console users only (customers never log in).
 * Every field comes from the verified principal; each scope returns only its own fields:
 *   PLATFORM → scope, role, user
 *   BRAND    → + brand_id, brand_name
 *   RETAIL   → + brand_id, brand_name, retailer_id, retailer_name, store_id, store
 * A RETAIL_ADMIN has exactly ONE store: `store`, never a list of stores.
 */
export function meRouter(): Router {
  const router = Router();
  router.get('/me', (_req, res) => {
    const principal = getPrincipal(res);
    const base = {
      scope: principal.scope,
      role: principal.role,
      user: { user_id: principal.userId, email: principal.email },
    };
    const brand = res.locals.brand;
    const brandFields = { brand_id: brand?.brandId ?? null, brand_name: brand?.name ?? null };

    switch (principal.scope) {
      case 'PLATFORM':
        return res.json(base);
      case 'BRAND':
        return res.json({ ...base, ...brandFields });
      case 'RETAIL':
        return res.json({
          ...base,
          ...brandFields,
          retailer_id: principal.retailerId,
          retailer_name: res.locals.retailer?.name ?? null,
          store_id: principal.storeId,
          store: res.locals.store ? storeJson(res.locals.store) : null,
        });
    }
  });
  return router;
}
