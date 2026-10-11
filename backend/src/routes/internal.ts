import { Router } from 'express';
import type { ScheduledWorkService } from '../application/scheduledWork.js';
import { AppError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import type { OidcTokenVerifier } from '../ports/oidc.js';

const unauthorized = () => new AppError(401, 'AUTH_INVALID', 'A valid scheduler identity token is required.');

/**
 * PUBLIC (no console user): POST /api/internal/process-due — Cloud Scheduler only (L1).
 * The caller must present a Google-signed OIDC token whose audience is exactly this
 * endpoint's URL (`<PUBLIC_BACKEND_URL>/api/internal/process-due`) and whose email is the
 * scheduler service account (SCHEDULER_SERVICE_ACCOUNT, verified). Anything else → 401.
 * Rate-limited; the per-brand runs are audited by the due-work service (SYSTEM actor).
 */
export function internalRouter(
  work: Pick<ScheduledWorkService, 'processDue'>,
  verifier: OidcTokenVerifier,
  scheduler: { serviceAccount: string; audience: string },
  limiter = new RateLimiter(6, 60_000),
  perIp = new RateLimiter(30, 60_000),
): Router {
  const router = Router();
  router.post('/process-due', async (req, res) => {
    if (!perIp.hit(`ip:${req.ip}`))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
    const header = req.get('Authorization') ?? '';
    const token = /^Bearer ([\w.-]+)$/.exec(header)?.[1];
    if (!token) throw unauthorized();
    let email: string;
    try {
      const verified = await verifier.verify(token, scheduler.audience);
      if (verified.audience !== scheduler.audience || !verified.emailVerified) throw new Error('claims');
      email = verified.email;
    } catch {
      throw unauthorized();
    }
    if (email.toLowerCase() !== scheduler.serviceAccount.toLowerCase()) throw unauthorized();
    if (!limiter.hit('process-due'))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
    const r = await work.processDue();
    res.json({
      brands: r.brands,
      failed: r.failed,
      sent: r.sent,
      suppressed: r.suppressed,
      abandoned: r.abandoned,
      reservations_expired: r.reservationsExpired,
      outcomes_closed: r.outcomesClosed,
    });
  });
  return router;
}
