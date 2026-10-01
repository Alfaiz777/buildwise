import { Router } from 'express';
import { z } from 'zod';
import type { FulfilmentService } from '../application/fulfilmentService.js';
import type { ReservationService } from '../application/reservationService.js';
import { getRetailPrincipal, getTenantPrincipal, requireScope } from '../auth/authorize.js';
import { isValidTenantId } from '../domain/principal.js';
import {
  CANCEL_NOTE_MAX,
  REFUSAL_REASONS,
  RESERVATION_STATUSES,
  type TransitionRejection,
} from '../domain/reservationStatus.js';
import { AppError, Errors } from '../lib/errors.js';

const ListQuery = z.object({
  store_id: z.string().min(1).max(128).optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  view: z.enum(['active', 'history']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const PatchBody = z
  .object({
    status: z.enum(RESERVATION_STATUSES),
    expected_current_status: z.enum(RESERVATION_STATUSES),
    cancel_reason: z.enum(REFUSAL_REASONS).optional(),
    cancel_note: z.string().max(CANCEL_NOTE_MAX).optional(),
    pickup_code: z
      .string()
      .regex(/^\s*\d{6}\s*$/)
      .optional(),
  })
  .strict();

const REJECTION: Record<TransitionRejection, () => AppError> = {
  STALE_STATUS: () =>
    new AppError(409, 'STALE_STATUS', 'This reservation changed since you loaded it. Refresh and try again.'),
  INVALID_TRANSITION: () => new AppError(409, 'INVALID_TRANSITION', 'That status change is not allowed now.'),
  PICKUP_CODE_MISMATCH: () =>
    new AppError(422, 'PICKUP_CODE_MISMATCH', "The pickup code doesn't match. Ask the customer to show it again."),
  PICKUP_CODE_LOCKED: () =>
    new AppError(
      429,
      'PICKUP_CODE_LOCKED',
      'Too many wrong pickup codes for this reservation. It cannot be completed; refuse it if needed.',
    ),
  REASON_REQUIRED: () => Errors.invalidRequest('A refusal needs a reason.'),
};

/**
 * Reservations (docs/06_INTEGRATION_CONTRACTS.md §14.4). Reads: BRAND_ADMIN brand-wide,
 * RETAIL_ADMIN its own store only. Status changes: RETAIL_ADMIN, own store only (another
 * store — even of the same retailer — is 404); BRAND_ADMIN / PLATFORM_ADMIN → 403.
 */
export function reservationsRouter(reservations: ReservationService, fulfilment: FulfilmentService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) throw Errors.invalidRequest('Invalid reservation filter.');
    const rows = await reservations.listFor(getTenantPrincipal(res), {
      storeId: query.data.store_id,
      status: query.data.status,
      view: query.data.view,
      limit: query.data.limit,
    });
    res.json({ reservations: rows });
  });

  router.get('/:reservationId', async (req, res) => {
    const id = req.params.reservationId;
    if (typeof id !== 'string' || !isValidTenantId(id)) throw Errors.notFound();
    const row = await reservations.getFor(getTenantPrincipal(res), id);
    if (!row) throw Errors.notFound();
    res.json(row);
  });

  router.patch('/:reservationId', requireScope('RETAIL'), async (req, res) => {
    const id = req.params.reservationId;
    if (typeof id !== 'string' || !isValidTenantId(id)) throw Errors.notFound();
    const body = PatchBody.safeParse(req.body);
    if (!body.success) throw Errors.invalidRequest('Invalid status change.');
    if (body.data.status === 'COMPLETED' && !body.data.pickup_code) {
      throw Errors.invalidRequest('Completing a reservation needs the customer’s pickup code.');
    }
    const principal = getRetailPrincipal(res);
    const { result, notification } = await fulfilment.transition(principal, id, {
      to: body.data.status,
      expectedCurrentStatus: body.data.expected_current_status,
      cancelReason: body.data.cancel_reason ?? null,
      cancelNote: body.data.cancel_note ?? null,
      pickupCode: body.data.pickup_code ?? null,
    });
    if (result.status === 'NOT_FOUND') throw Errors.notFound();
    if (result.status === 'REJECTED') throw REJECTION[result.reason]();
    res.json({
      ...(await reservations.getFor(principal, id)),
      notification: notification
        ? { status: notification.status, event: notification.event, message_kind: notification.messageKind }
        : null,
    });
  });

  return router;
}
