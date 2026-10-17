import { Router } from 'express';
import { z } from 'zod';
import { movementJson, saleJson, type StoreSalesService } from '../application/storeSalesService.js';
import { getBrandPrincipal, getRetailPrincipal } from '../auth/authorize.js';
import { isValidTenantId } from '../domain/principal.js';
import { MAX_LINE_QUANTITY, MAX_SALE_LINES, PAYMENT_METHODS } from '../domain/storeSale.js';
import { Errors } from '../lib/errors.js';

/**
 * In-store sales (Change 19).
 *
 * Store Console (mounted under /api/retail behind requireScope('RETAIL'); the path store must be
 * the Retail Admin's own store, anything else is 404):
 *   POST /stores/:storeId/sales                    record a walk-in sale (invoice) — deducts stock
 *   GET  /stores/:storeId/sales?days=1|7|28        the store's invoices and totals
 *   POST /stores/:storeId/sales/:saleId/void       void within 24 h (reason required) — stock comes back
 *   GET  /stores/:storeId/stock-history?sku=       the latest stock changes and why
 *
 * Brand Console (mounted under /api/brand behind requireScope('BRAND')):
 *   GET  /sales?days=7|28                          every store's walk-in sales beside its Qwikspot pickups
 *
 * An invoice never carries a customer: no name, phone or email field exists.
 */
const SaleBody = z
  .object({
    lines: z
      .array(
        z
          .object({
            sku: z.string().trim().min(1).max(64),
            quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SALE_LINES),
    payment_method: z.enum(PAYMENT_METHODS),
  })
  .strict();
const VoidBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
const StoreDays = z.object({ days: z.enum(['1', '7', '28']).default('7') });
const BrandDays = z.object({ days: z.enum(['7', '28']).default('7') });
const SALE_ID = /^sale_[a-f0-9]{16}$/;

export function storeSalesRetailRouter(sales: StoreSalesService): Router {
  const router = Router();
  const storeOf = (raw: unknown) => {
    if (typeof raw !== 'string' || !isValidTenantId(raw)) throw Errors.notFound();
    return raw;
  };

  router.post('/stores/:storeId/sales', async (req, res) => {
    const storeId = storeOf(req.params.storeId);
    const body = SaleBody.safeParse(req.body);
    if (!body.success)
      throw Errors.invalidRequest(
        `An invoice lists 1 to ${MAX_SALE_LINES} products by SKU, each with a whole quantity from 1 to ${MAX_LINE_QUANTITY}, and a payment method (${PAYMENT_METHODS.join(', ')}).`,
      );
    const sale = await sales.record(getRetailPrincipal(res), storeId, {
      lines: body.data.lines,
      paymentMethod: body.data.payment_method,
    });
    res.status(201).json(saleJson(sale));
  });

  router.get('/stores/:storeId/sales', async (req, res) => {
    const storeId = storeOf(req.params.storeId);
    const q = StoreDays.safeParse(req.query);
    if (!q.success) throw Errors.invalidRequest('Period must be 1, 7 or 28 days.');
    const result = await sales.storeSales(getRetailPrincipal(res), storeId, Number(q.data.days));
    res.json({ store_id: storeId, sales: result.sales.map(saleJson), totals: result.totals });
  });

  router.post('/stores/:storeId/sales/:saleId/void', async (req, res) => {
    const storeId = storeOf(req.params.storeId);
    const saleId = req.params.saleId;
    if (typeof saleId !== 'string' || !SALE_ID.test(saleId)) throw Errors.notFound();
    const body = VoidBody.safeParse(req.body);
    if (!body.success) throw Errors.invalidRequest('Say why the sale is voided (3–200 characters).');
    res.json(saleJson(await sales.void(getRetailPrincipal(res), storeId, saleId, body.data.reason)));
  });

  router.get('/stores/:storeId/stock-history', async (req, res) => {
    const storeId = storeOf(req.params.storeId);
    const sku = typeof req.query.sku === 'string' && req.query.sku.length <= 64 ? req.query.sku : undefined;
    const moves = await sales.stockHistory(getRetailPrincipal(res), storeId, sku);
    res.json({ store_id: storeId, movements: moves.map(movementJson) });
  });

  return router;
}

export function storeSalesBrandRouter(sales: StoreSalesService): Router {
  const router = Router();
  router.get('/sales', async (req, res) => {
    const q = BrandDays.safeParse(req.query);
    if (!q.success) throw Errors.invalidRequest('Period must be 7 or 28 days.');
    res.json(await sales.brandSummary(getBrandPrincipal(res).brandId, Number(q.data.days)));
  });
  return router;
}
