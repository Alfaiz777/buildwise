import { canAccessTenantResource } from '../domain/access.js';
import type { RetailPrincipal } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import type { StoreRecord, StoreRepository } from '../ports/repositories.js';

/** Read-side account context for GET /api/me and the Retailer Console. */
export class AccountService {
  constructor(private readonly stores: StoreRepository) {}

  /** The ONE store a RETAIL_ADMIN operates (verified at sign-in). */
  async ownStore(principal: RetailPrincipal): Promise<StoreRecord> {
    return this.storeFor(principal, principal.storeId);
  }

  /** A store by ID, only if it is the principal's own store; anything else → 404. */
  async storeFor(principal: RetailPrincipal, storeId: string): Promise<StoreRecord> {
    const store = await this.stores.get(principal.brandId, storeId);
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
}
