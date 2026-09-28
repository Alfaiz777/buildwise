import { describe, expect, it } from 'vitest';
import {
  decideStoreAssignment,
  isConsistentRetailOwnership,
  type StoreAssignmentState,
} from '../src/domain/retailOwnership.js';

describe('decideStoreAssignment — a store belongs to exactly one retailer (pure rule)', () => {
  const free = { storeId: 'store_X', retailerId: null, retailAdminUserId: null };
  const owned = (retailAdminUserId: string | null = null) => ({
    storeId: 'store_X',
    retailerId: 'rtl_1',
    retailAdminUserId,
  });
  const cases: [string, StoreAssignmentState, ReturnType<typeof decideStoreAssignment>][] = [
    ['missing store', { store: null, target: null }, { ok: false, code: 'STORE_NOT_FOUND' }],
    ['missing retailer', { store: free, target: undefined }, { ok: false, code: 'RETAILER_NOT_FOUND' }],
    ['free store → retailer', { store: free, target: { retailerId: 'rtl_1' } }, { ok: true, change: 'ASSIGN' }],
    [
      'store already owned by another retailer',
      { store: owned(), target: { retailerId: 'rtl_2' } },
      { ok: false, code: 'STORE_ALREADY_ASSIGNED' },
    ],
    ['same pairing again', { store: owned('u1'), target: { retailerId: 'rtl_1' } }, { ok: true, change: 'NONE' }],
    ['unassign a store without a Retail Admin', { store: owned(), target: null }, { ok: true, change: 'UNASSIGN' }],
    [
      'unassign a store operated by its Retail Admin',
      { store: owned('u1'), target: null },
      { ok: false, code: 'STORE_HAS_ADMIN' },
    ],
    ['unassign an already free store', { store: free, target: null }, { ok: true, change: 'NONE' }],
  ];

  it.each(cases)('%s', (_label, state, expected) => {
    expect(decideStoreAssignment(state)).toEqual(expected);
  });

  it('a retailer may own many stores: the rule never looks at the retailer’s other stores', () => {
    // rtl_1 already owns store_A and store_B elsewhere; assigning a third store is fine.
    expect(decideStoreAssignment({ store: free, target: { retailerId: 'rtl_1' } })).toEqual({
      ok: true,
      change: 'ASSIGN',
    });
  });
});

describe('isConsistentRetailOwnership — the single store_id is the authorization boundary', () => {
  const ok = {
    userId: 'u1',
    userRetailerId: 'rtl_1',
    userStoreId: 'store_1',
    store: { storeId: 'store_1', retailerId: 'rtl_1', retailAdminUserId: 'u1' },
  };

  it('accepts the store’s recorded admin whose retailer matches', () => {
    expect(isConsistentRetailOwnership(ok)).toBe(true);
  });

  it.each([
    ['not the store’s recorded admin', { ...ok, store: { ...ok.store, retailAdminUserId: 'u2' } }],
    ['store has no recorded admin', { ...ok, store: { ...ok.store, retailAdminUserId: null } }],
    ['user names another store', { ...ok, userStoreId: 'store_2' }],
    ['store missing', { ...ok, store: null }],
    ['store belongs to another retailer', { ...ok, store: { ...ok.store, retailerId: 'rtl_2' } }],
    ['store unassigned', { ...ok, store: { ...ok.store, retailerId: null } }],
    ['user names another retailer', { ...ok, userRetailerId: 'rtl_2' }],
  ])('rejects: %s', (_label, args) => {
    expect(isConsistentRetailOwnership(args)).toBe(false);
  });
});
