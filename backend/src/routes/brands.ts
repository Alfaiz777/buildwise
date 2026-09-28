import { Router } from 'express';
import { assertTenantAccess, getTenantPrincipal, requireScope } from '../auth/authorize.js';
import { Errors } from '../lib/errors.js';
import type { BrandRepository } from '../ports/repositories.js';

/**
 * GET /api/brands/:brandId — basic brand profile (docs/06_INTEGRATION_CONTRACTS.md §14).
 * Brand scope only. The path ID is checked against the principal and then
 * ignored: the read always uses principal.brandId.
 */
export function brandsRouter(brands: BrandRepository): Router {
  const router = Router();
  router.get('/brands/:brandId', requireScope('BRAND'), async (req, res) => {
    const principal = getTenantPrincipal(res);
    const requested = req.params.brandId;
    if (typeof requested !== 'string') throw Errors.notFound();
    assertTenantAccess(principal, { brandId: requested });

    const brand = await brands.getById(principal.brandId);
    if (!brand) throw Errors.notFound();
    res.json({ brand_id: brand.brandId, name: brand.name, status: brand.status });
  });
  return router;
}
