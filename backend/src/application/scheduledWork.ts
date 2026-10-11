import type { BrandRepository } from '../ports/repositories.js';
import type { FollowUpService } from './followUpService.js';

export interface ScheduledRunResult {
  brands: number;
  failed: number;
  sent: number;
  suppressed: number;
  abandoned: number;
  reservationsExpired: number;
  outcomesClosed: number;
}

/**
 * The due work Cloud Scheduler runs every few minutes (L1, docs/12 §9): for each ACTIVE brand,
 * the same run as the Brand Console's "Process due work now" — abandoned sessions, due
 * follow-ups, the hold-expiry sweep and the NONE-outcome (attribution window) sweep. Each
 * brand's run is audited DUE_WORK_PROCESSED with the SYSTEM actor `cloud-scheduler`. One
 * brand's failure never stops the others.
 */
export class ScheduledWorkService {
  constructor(private readonly deps: { brands: BrandRepository; followUps: Pick<FollowUpService, 'processDue'> }) {}

  async processDue(): Promise<ScheduledRunResult> {
    const result: ScheduledRunResult = {
      brands: 0,
      failed: 0,
      sent: 0,
      suppressed: 0,
      abandoned: 0,
      reservationsExpired: 0,
      outcomesClosed: 0,
    };
    for (const brand of await this.deps.brands.list()) {
      if (brand.status !== 'ACTIVE') continue;
      result.brands += 1;
      try {
        const r = await this.deps.followUps.processDue(brand.brandId, { type: 'SYSTEM', id: 'cloud-scheduler' });
        result.sent += r.sent;
        result.suppressed += r.suppressed;
        result.abandoned += r.abandoned;
        result.reservationsExpired += r.reservationsExpired;
        result.outcomesClosed += r.outcomesClosed;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }
}
