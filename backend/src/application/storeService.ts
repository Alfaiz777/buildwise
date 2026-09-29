import { findEligibleStores, type EligibilityResult, type GeoPoint } from '../domain/storeTruth.js';
import type { InventoryRepository, StoreRepository } from '../ports/repositories.js';

/**
 * StoreService (docs/06_INTEGRATION_CONTRACTS.md §4): reads stores and stock from
 * Firestore and applies the pure store-truth rules. Used by the agent tools from M5;
 * there is deliberately no customer-facing HTTP route in M3.
 */
export class StoreService {
  constructor(private readonly deps: { stores: StoreRepository; inventory: InventoryRepository; now?: () => Date }) {}

  async findEligibleStores(
    brandId: string,
    variantId: string,
    origin: GeoPoint,
    radiusKm: number,
  ): Promise<EligibilityResult> {
    const [stores, stock] = await Promise.all([
      this.deps.stores.list(brandId),
      this.deps.inventory.listByVariant(brandId, variantId),
    ]);
    const byStore = new Map(stock.map((row) => [row.storeId, row]));
    return findEligibleStores({
      origin,
      radiusKm,
      now: (this.deps.now ?? (() => new Date()))(),
      candidates: stores.map((store) => ({ store, inventory: byStore.get(store.storeId) ?? null })),
    });
  }
}
