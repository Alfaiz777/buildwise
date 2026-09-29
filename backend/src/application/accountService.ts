import { canAccessTenantResource } from '../domain/access.js';
import type { RetailPrincipal } from '../domain/principal.js';
import { availableQuantity } from '../domain/storeTruth.js';
import { Errors } from '../lib/errors.js';
import type {
  InventoryRecord,
  InventoryRepository,
  ProductRepository,
  StoreRecord,
  StoreRepository,
} from '../ports/repositories.js';

export interface StoreStockLine extends InventoryRecord {
  productTitle: string | null;
  variantTitle: string | null;
  availableQuantity: number;
}

/** Read-side account context for GET /api/me and the Retailer Console. */
export class AccountService {
  constructor(
    private readonly deps: { stores: StoreRepository; inventory: InventoryRepository; products: ProductRepository },
  ) {}

  /** The ONE store a RETAIL_ADMIN operates (verified at sign-in). */
  async ownStore(principal: RetailPrincipal): Promise<StoreRecord> {
    return this.storeFor(principal, principal.storeId);
  }

  /** A store by ID, only if it is the principal's own store; anything else → 404. */
  async storeFor(principal: RetailPrincipal, storeId: string): Promise<StoreRecord> {
    const store = await this.deps.stores.get(principal.brandId, storeId);
    if (
      !store ||
      !canAccessTenantResource(principal, {
        brandId: store.brandId,
        retailerId: store.retailerId,
        storeId: store.storeId,
      })
    ) {
      throw Errors.notFound();
    }
    return store;
  }

  /** Read-only stock of the principal's own store (any other store → 404). */
  async storeStock(principal: RetailPrincipal, storeId: string): Promise<StoreStockLine[]> {
    const store = await this.storeFor(principal, storeId);
    const [stock, products, variants] = await Promise.all([
      this.deps.inventory.listByStore(principal.brandId, store.storeId),
      this.deps.products.listProducts(principal.brandId),
      this.deps.products.listVariants(principal.brandId),
    ]);
    const productTitle = new Map(products.map((p) => [p.productId, p.title]));
    const variant = new Map(variants.map((v) => [v.variantId, v]));
    return stock
      .map((row) => {
        const v = variant.get(row.variantId);
        return {
          ...row,
          productTitle: v ? (productTitle.get(v.productId) ?? null) : null,
          variantTitle: v?.title ?? null,
          availableQuantity: availableQuantity(row.quantity, row.reservedQuantity),
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }
}
