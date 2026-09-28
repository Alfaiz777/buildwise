import { Router } from 'express';
import { z } from 'zod';
import type { TenantAdminService } from '../application/tenantAdminService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { isValidTenantId } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { parseInput } from '../lib/validation.js';
import type { RetailerRecord, StoreRecord } from '../ports/repositories.js';
import { userJson } from './platform.js';

/**
 * /api/brand/* — brand administration by the brand's single BRAND_ADMIN
 * (docs/06_INTEGRATION_CONTRACTS.md §14.7). Mounted behind requireScope('BRAND').
 *
 * There is intentionally no route to create a BRAND_ADMIN: only PLATFORM_ADMIN
 * provisions a brand's (one) Brand Admin. Retail Admin provisioning is store-based:
 * one RETAIL_ADMIN per store, never retailer-wide.
 */

const Email = z.object({ email: z.string().trim().email().max(254) });
const CreateRetailer = z.object({ name: z.string().trim().min(1).max(120) });
const AssignStore = z.object({
  retailer_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
});

const retailerJson = (r: RetailerRecord) => ({
  retailer_id: r.retailerId,
  name: r.name,
  status: r.status,
});

const storeAdminJson = (s: StoreRecord) => ({
  store_id: s.storeId,
  store_name: s.storeName,
  city: s.city,
  store_status: s.storeStatus,
  retailer_id: s.retailerId,
  retail_admin_user_id: s.retailAdminUserId,
});

function idParam(value: unknown): string {
  if (typeof value !== 'string' || !isValidTenantId(value)) throw Errors.notFound();
  return value;
}

export function brandAdminRouter(admin: TenantAdminService): Router {
  const router = Router();

  /** Read-only: the brand's Brand Admin and its stores' Retail Admins. */
  router.get('/users', async (_req, res) => {
    const users = await admin.listUsers(getBrandPrincipal(res));
    res.json({
      users: users.map((u) => ({
        user_id: u.userId,
        email: u.email,
        role: u.role,
        retailer_id: u.retailerId,
        store_id: u.storeId,
        status: u.status,
      })),
    });
  });

  router.get('/retailers', async (_req, res) => {
    const retailers = await admin.listRetailers(getBrandPrincipal(res));
    res.json({ retailers: retailers.map(retailerJson) });
  });

  router.post('/retailers', async (req, res) => {
    const { name } = parseInput(CreateRetailer, req.body);
    res.status(201).json(retailerJson(await admin.createRetailer(getBrandPrincipal(res), name)));
  });

  /** The brand's stores (from the retail/store data flow) with their retailer and Retail Admin. */
  router.get('/stores', async (_req, res) => {
    const stores = await admin.listStores(getBrandPrincipal(res));
    res.json({ stores: stores.map(storeAdminJson) });
  });

  /**
   * Provisions the single RETAIL_ADMIN of one store (brand, retailer and store come from
   * the store record). Returns the local password-setup link.
   * A second one → 409 RETAIL_ADMIN_ALREADY_PROVISIONED; store without a retailer → 409 STORE_HAS_NO_RETAILER.
   */
  router.post('/stores/:storeId/admins', async (req, res) => {
    const { email } = parseInput(Email, req.body);
    const user = await admin.createRetailAdmin(getBrandPrincipal(res), idParam(req.params.storeId), email);
    res.status(201).json(userJson(user));
  });

  /**
   * Store → retailer association (a store belongs to one retailer; a retailer may own many).
   * Backend-only in M2 (no console UI): the only way to associate existing stores before
   * retail ingestion (M4), and exercised by the tests. 409 STORE_ALREADY_ASSIGNED /
   * STORE_HAS_ADMIN on violations.
   */
  router.patch('/stores/:storeId', async (req, res) => {
    const { retailer_id } = parseInput(AssignStore, req.body);
    const store = await admin.assignStoreRetailer(getBrandPrincipal(res), idParam(req.params.storeId), retailer_id);
    res.json(storeAdminJson(store));
  });

  return router;
}
