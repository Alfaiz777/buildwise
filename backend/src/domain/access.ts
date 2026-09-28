import type { Principal } from './principal.js';

/**
 * A tenant resource as seen by the access rules. Store-level resources (a store,
 * its inventory, its reservations) carry `storeId` and the store's `retailerId`.
 */
export interface TenantResource {
  readonly brandId: string;
  readonly retailerId?: string | null;
  readonly storeId?: string;
}

/**
 * Step 4 of the auth chain, as a pure rule (docs/07_SECURITY_SPEC.md §4.1):
 *   PLATFORM → never (platform scope uses /api/platform/* only)
 *   BRAND    → resource in the same brand
 *   RETAIL   → same brand AND same retailer AND the principal's own store.
 *              A RETAIL_ADMIN operates exactly one store; brand- or retailer-level
 *              resources without a store, and every other store, are out of scope.
 */
export function canAccessTenantResource(principal: Principal, resource: TenantResource): boolean {
  switch (principal.scope) {
    case 'PLATFORM':
      return false;
    case 'BRAND':
      return resource.brandId === principal.brandId;
    case 'RETAIL':
      return (
        resource.brandId === principal.brandId &&
        resource.retailerId === principal.retailerId &&
        resource.storeId === principal.storeId
      );
  }
}
