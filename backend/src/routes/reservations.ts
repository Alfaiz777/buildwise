import { Router } from 'express';
import { z } from 'zod';
import type { ReservationService } from '../application/reservationService.js';
import { getTenantPrincipal } from '../auth/authorize.js';
import { RESERVATION_STATUSES } from '../domain/reservationStatus.js';
import { Errors } from '../lib/errors.js';

const ListQuery = z.object({
  store_id: z.string().min(1).max(128).optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/reservations (docs/06_INTEGRATION_CONTRACTS.md §14.4), read-only in M5.
 * BRAND_ADMIN: all of its brand's reservations. RETAIL_ADMIN: its own store only — any
 * other store_id returns nothing. The brand always comes from the verified principal.
 */
export function reservationsRouter(reservations: ReservationService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) throw Errors.invalidRequest('Invalid reservation filter.');
    const rows = await reservations.listFor(getTenantPrincipal(res), {
      storeId: query.data.store_id,
      status: query.data.status,
      limit: query.data.limit,
    });
    res.json({ reservations: rows });
  });

  return router;
}
