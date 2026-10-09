import type { Logger } from '../lib/logger.js';
import type { CommerceSyncService, SyncActor } from './commerceSyncService.js';

const ACTOR: SyncActor = { type: 'SYSTEM', id: 'shopify-webhook' };

/**
 * Keeps the catalogue current after Shopify's products/create, products/update and
 * products/delete webhooks (L2-Shopify), without waiting for someone to press Sync.
 * Shopify wants its answer within 5 seconds, so the sync runs in the background. A burst of
 * webhooks (a bulk edit) coalesces per brand into the running sync plus at most one more,
 * which starts after it and therefore includes every change that arrived meanwhile.
 * A failed sync is logged; the next webhook or a manual Sync catches up.
 */
export class ShopifyCatalogRefresh {
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();

  constructor(private readonly deps: { sync: Pick<CommerceSyncService, 'sync'>; logger?: Logger }) {}

  /** Queues a catalogue sync for the brand; the promise settles once a sync that includes this change has run. */
  request(brandId: string): Promise<void> {
    const current = this.running.get(brandId);
    if (current) {
      this.pending.add(brandId);
      return current.then(() => this.idle(brandId));
    }
    const run = (async () => {
      do {
        this.pending.delete(brandId);
        try {
          await this.deps.sync.sync(brandId, ACTOR);
        } catch (err) {
          this.deps.logger?.warn('shopify.catalog_refresh_failed', {
            brand_id: brandId,
            error_code: (err as { code?: string }).code ?? 'ERROR',
          });
        }
      } while (this.pending.has(brandId));
    })().finally(() => {
      this.running.delete(brandId);
      // A request that arrived after the last check still gets its sync.
      if (this.pending.has(brandId)) void this.request(brandId);
    });
    this.running.set(brandId, run);
    return run;
  }

  /** Settles when no sync is running for the brand (tests, shutdown). */
  async idle(brandId: string): Promise<void> {
    await this.running.get(brandId);
  }
}
