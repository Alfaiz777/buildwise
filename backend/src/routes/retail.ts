import { Router } from 'express';
import type { AccountService } from '../application/accountService.js';
import { getRetailPrincipal } from '../auth/authorize.js';
import { isValidTenantId } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { storeJson } from './me.js';

/**
 * /api/retail/* — Retailer Console, RETAIL_ADMIN only (mounted behind requireScope('RETAIL')).
 * Every route is store-scoped: the path store must be the principal's own store,
 * anything else is 404 (docs/07_SECURITY_SPEC.md §4.1). Inventory and reservations
 * for the store arrive in later milestones.
 */
export function retailRouter(account: AccountService): Router {
  const router = Router();

  router.get('/stores/:storeId', async (req, res) => {
    const storeId = req.params.storeId;
    if (typeof storeId !== 'string' || !isValidTenantId(storeId)) throw Errors.notFound();
    const store = await account.storeFor(getRetailPrincipal(res), storeId);
    res.json(storeJson(store));
  });

  return router;
}
