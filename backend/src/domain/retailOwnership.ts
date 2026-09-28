/**
 * MVP retail ownership (docs/04_DATA_MODEL.md §8a):
 *
 *   Brand
 *    └── Retailer            (retail business / partner; may own MANY stores)
 *         ├── Store A ── RETAIL_ADMIN_A
 *         └── Store B ── RETAIL_ADMIN_B
 *
 * A store belongs to exactly one retailer (`RetailStore.retailer_id`), has at most one
 * RETAIL_ADMIN (`RetailStore.retail_admin_user_id`), and a RETAIL_ADMIN operates exactly
 * that one store. There is no multi-store Retail Admin. These rules are pure so that the
 * persistence adapter only applies the decision inside a transaction.
 */

export interface StoreAssignmentState {
  /** The store being (un)assigned, or null if it does not exist in the brand. */
  store: { storeId: string; retailerId: string | null; retailAdminUserId: string | null } | null;
  /** The target retailer (null = unassign), or undefined if the target does not exist. */
  target: { retailerId: string } | null | undefined;
}

export type StoreAssignmentDecision =
  | { ok: true; change: 'ASSIGN' | 'UNASSIGN' | 'NONE' }
  | { ok: false; code: 'STORE_NOT_FOUND' | 'RETAILER_NOT_FOUND' | 'STORE_ALREADY_ASSIGNED' | 'STORE_HAS_ADMIN' };

export function decideStoreAssignment(state: StoreAssignmentState): StoreAssignmentDecision {
  const { store, target } = state;
  if (!store) return { ok: false, code: 'STORE_NOT_FOUND' };
  if (target === undefined) return { ok: false, code: 'RETAILER_NOT_FOUND' };

  if (target === null) {
    if (!store.retailerId) return { ok: true, change: 'NONE' };
    // Unassigning would leave the store's RETAIL_ADMIN without a retailer.
    if (store.retailAdminUserId) return { ok: false, code: 'STORE_HAS_ADMIN' };
    return { ok: true, change: 'UNASSIGN' };
  }

  if (store.retailerId === target.retailerId) return { ok: true, change: 'NONE' };
  // One store belongs to only one retailer: moving it requires an explicit unassign first.
  if (store.retailerId) return { ok: false, code: 'STORE_ALREADY_ASSIGNED' };
  // A retailer may own any number of stores.
  return { ok: true, change: 'ASSIGN' };
}

/**
 * A RETAIL_ADMIN is valid only when it is the store's recorded admin and user and
 * store agree on the retailer: the single store_id is the authorization boundary.
 */
export function isConsistentRetailOwnership(args: {
  userId: string;
  userRetailerId: string;
  userStoreId: string;
  store: { storeId: string; retailerId: string | null; retailAdminUserId: string | null } | null;
}): boolean {
  const { userId, userRetailerId, userStoreId, store } = args;
  return (
    store !== null &&
    store.storeId === userStoreId &&
    store.retailAdminUserId === userId &&
    store.retailerId === userRetailerId
  );
}
