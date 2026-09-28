import { Router } from 'express';
import { z } from 'zod';
import type { PlatformAdminService } from '../application/platformAdminService.js';
import type { ProvisionedUser } from '../application/provisioning.js';
import { getPlatformPrincipal } from '../auth/authorize.js';
import { isValidTenantId } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { parseInput } from '../lib/validation.js';
import type { BrandRecord } from '../ports/repositories.js';

/**
 * /api/platform/* — PLATFORM_ADMIN only (mounted behind requireScope('PLATFORM')).
 * M2 minimum (docs/06_INTEGRATION_CONTRACTS.md §14.6). No customer data is ever returned.
 */

const brandJson = (b: BrandRecord) => ({
  brand_id: b.brandId,
  name: b.name,
  status: b.status,
  created_at: b.createdAt,
  brand_admin_user_id: b.brandAdminUserId,
});

export const userJson = (u: ProvisionedUser) => ({
  user_id: u.userId,
  email: u.email,
  role: u.role,
  password_setup_link: u.passwordSetupLink,
});

const CreateBrand = z.object({ name: z.string().trim().min(1).max(120) });
const SetStatus = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: z.string().trim().max(200).optional(),
});
const ProvisionAdmin = z.object({ email: z.string().trim().email().max(254) });
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

function brandIdParam(value: unknown): string {
  if (typeof value !== 'string' || !isValidTenantId(value)) throw Errors.notFound();
  return value;
}

export function platformRouter(platform: PlatformAdminService): Router {
  const router = Router();

  router.get('/brands', async (_req, res) => {
    getPlatformPrincipal(res);
    res.json({ brands: (await platform.listBrands()).map(brandJson) });
  });

  router.post('/brands', async (req, res) => {
    const actor = getPlatformPrincipal(res);
    const { name } = parseInput(CreateBrand, req.body);
    res.status(201).json(brandJson(await platform.createBrand(actor, name)));
  });

  router.patch('/brands/:brandId', async (req, res) => {
    const actor = getPlatformPrincipal(res);
    const { status, reason } = parseInput(SetStatus, req.body);
    const brand = await platform.setBrandStatus(actor, brandIdParam(req.params.brandId), status, reason ?? null);
    res.json(brandJson(brand));
  });

  router.post('/brands/:brandId/admins', async (req, res) => {
    const actor = getPlatformPrincipal(res);
    const { email } = parseInput(ProvisionAdmin, req.body);
    const user = await platform.provisionBrandAdmin(actor, brandIdParam(req.params.brandId), email);
    res.status(201).json(userJson(user));
  });

  router.get('/audit', async (req, res) => {
    getPlatformPrincipal(res);
    const { limit } = parseInput(AuditQuery, req.query);
    const events = await platform.listAudit(limit);
    res.json({
      events: events.map((e) => ({
        audit_id: e.auditId,
        actor_id: e.actorId,
        action: e.action,
        target_brand_id: e.targetBrandId,
        target_type: e.targetType,
        target_id: e.targetId,
        result: e.result,
        reason_code: e.reasonCode,
        timestamp: e.timestamp,
      })),
    });
  });

  return router;
}
