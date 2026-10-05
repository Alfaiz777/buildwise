import { Router } from 'express';
import { z } from 'zod';
import type { AccountService } from '../application/accountService.js';
import type { InsightsService } from '../application/insightsService.js';
import type { ReservationService } from '../application/reservationService.js';
import { getRetailPrincipal } from '../auth/authorize.js';
import { isValidTenantId } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { storeJson } from './me.js';

/**
 * /api/retail/* — Retailer Console, RETAIL_ADMIN only (mounted behind requireScope('RETAIL')).
 * Every route is store-scoped: the path store must be the principal's own store,
 * anything else is 404 (docs/07_SECURITY_SPEC.md §4.1). Store stock is read-only (M3);
 * reservations for the store arrive in later milestones.
 */
const InsightsQuery = z.object({
  days: z.enum(['7', '28']).default('7'),
  include_history: z.enum(['true', 'false']).default('true'),
});

export function retailRouter(
  account: AccountService,
  reservations: ReservationService,
  insights?: InsightsService,
): Router {
  const router = Router();

  /** UI-4 "Demand near your store": the own store's insights slice (any other store → 404). */
  router.get('/stores/:storeId/insights', async (req, res) => {
    const storeId = req.params.storeId;
    const principal = getRetailPrincipal(res);
    if (!insights || typeof storeId !== 'string' || storeId !== principal.storeId) throw Errors.notFound();
    const q = InsightsQuery.safeParse(req.query);
    if (!q.success) throw Errors.invalidRequest('Period must be 7 or 28 days.');
    res.json(
      await insights.storePanel(principal.brandId, storeId, {
        days: Number(q.data.days) as 7 | 28,
        includeHistory: q.data.include_history === 'true',
      }),
    );
  });

  router.get('/stores/:storeId', async (req, res) => {
    const storeId = req.params.storeId;
    if (typeof storeId !== 'string' || !isValidTenantId(storeId)) throw Errors.notFound();
    const store = await account.storeFor(getRetailPrincipal(res), storeId);
    res.json(storeJson(store));
  });

  /** Read-only stock of the Retail Admin's own store (any other store → 404). */
  router.get('/stores/:storeId/inventory', async (req, res) => {
    const storeId = req.params.storeId;
    if (typeof storeId !== 'string' || !isValidTenantId(storeId)) throw Errors.notFound();
    const lines = await account.storeStock(getRetailPrincipal(res), storeId);
    res.json({
      store_id: storeId,
      items: lines.map((l) => ({
        sku: l.sku,
        canonical_sku: l.canonicalSku,
        variant_id: l.variantId,
        product_title: l.productTitle,
        variant_title: l.variantTitle,
        image_url: l.imageUrl ?? null,
        quantity: l.quantity,
        reserved_quantity: l.reservedQuantity,
        available_quantity: l.availableQuantity,
        availability_status: l.availabilityStatus,
        offline_price: l.offlinePrice,
        last_updated_at: l.lastUpdatedAt,
        stale: l.stale,
      })),
    });
  });

  /** M6 "This week" strip: the own store's reservations (any other store → 404). */
  router.get('/stores/:storeId/summary', async (req, res) => {
    const storeId = req.params.storeId;
    const principal = getRetailPrincipal(res);
    if (typeof storeId !== 'string' || storeId !== principal.storeId) throw Errors.notFound();
    // UI-4: the value of pickups uses this store's own current offline prices.
    const stock = await account.storeStock(principal, storeId);
    const prices = new Map(stock.filter((l) => l.offlinePrice !== null).map((l) => [l.sku, l.offlinePrice as number]));
    res.json(await reservations.weekSummary(principal, prices));
  });

  return router;
}
