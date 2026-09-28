import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/domain/principal.js';
import { MemoryUsers, bearer, buildTestWorld } from './helpers.js';

const { app } = buildTestWorld();
const me = (userId: string) => request(app).get('/api/me').set('Authorization', bearer(userId));

describe('auth chain step 1 — Firebase ID token verification', () => {
  it('rejects a request with no Authorization header (401 AUTH_REQUIRED)', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects an invalid token (401 AUTH_INVALID)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer forged');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });

  it('rejects an expired token (401 AUTH_EXPIRED)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer expired-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_EXPIRED');
  });

  it('returns a retryable 503 when verification itself is unavailable', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer firebase-down');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'AUTH_UNAVAILABLE', retryable: true });
  });
});

describe('the MVP role model', () => {
  it('has exactly three internal roles; the customer is not one of them', () => {
    expect(ROLES).toEqual(['PLATFORM_ADMIN', 'BRAND_ADMIN', 'RETAIL_ADMIN']);
    expect(ROLES).not.toContain('CUSTOMER');
  });
});

describe('auth chain step 2 — scoped principal resolution, one case per role', () => {
  it('PLATFORM_ADMIN → platform scope, no brand or retailer fields', async () => {
    const res = await me('platform');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: 'PLATFORM',
      role: 'PLATFORM_ADMIN',
      user: { user_id: 'platform', email: 'platform@example.test' },
    });
  });

  it('BRAND_ADMIN → brand scope for its own brand', async () => {
    const res = await me('admin_a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: 'BRAND',
      role: 'BRAND_ADMIN',
      user: { user_id: 'admin_a', email: 'admin_a@example.test' },
      brand_id: 'brand_A',
      brand_name: 'Brand brand_A',
    });
  });

  it('RETAIL_ADMIN → retail scope with exactly its one store (never a list of stores)', async () => {
    const res = await me('radmin_A');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: 'RETAIL',
      role: 'RETAIL_ADMIN',
      user: { user_id: 'radmin_A', email: 'radmin_A@example.test' },
      brand_id: 'brand_A',
      brand_name: 'Brand brand_A',
      retailer_id: 'rtl_A',
      retailer_name: 'Retailer rtl_A',
      store_id: 'store_A',
      store: {
        store_id: 'store_A',
        store_name: 'Store store_A',
        city: 'Mumbai',
        address: 'store_A street, Mumbai',
        store_status: 'ACTIVE',
        store_hours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
      },
    });
    expect(res.body).not.toHaveProperty('stores');
  });

  it('never lets the client choose the tenant (query, header or body brand_id ignored)', async () => {
    const res = await request(app)
      .get('/api/me?brand_id=brand_B')
      .set('Authorization', bearer('admin_a'))
      .set('X-Brand-Id', 'brand_B')
      .send({ brand_id: 'brand_B', retailer_id: 'rtl_b' });
    expect(res.status).toBe(200);
    expect(res.body.brand_id).toBe('brand_A');
  });
});

describe('auth chain step 2 — refusals', () => {
  it('valid Firebase user with no users/{uid} document → 403 USER_NOT_PROVISIONED', async () => {
    const res = await me('nobody');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_NOT_PROVISIONED');
  });

  it('disabled user → 403 USER_DISABLED', async () => {
    const res = await me('disabled_a');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_DISABLED');
  });

  it.each([
    ['unknown role', 'badrole'],
    ['CUSTOMER is not a console role', 'customer_role'],
    ['PLATFORM_ADMIN with a brand_id', 'platform_with_brand'],
    ['brand_id "ALL" (never a wildcard)', 'wildcard_brand'],
    ['BRAND_ADMIN with a retailer_id', 'brand_admin_with_retailer'],
    ['RETAIL_ADMIN without retailer_id', 'retail_admin_without_retailer'],
    ['RETAIL_ADMIN without brand_id', 'retail_admin_without_brand'],
    ['RETAIL_ADMIN without store_id', 'retail_admin_without_store'],
    ['RETAIL_ADMIN whose retailer_id does not match its store’s retailer', 'radmin_mismatch'],
    ['a second BRAND_ADMIN (not the brand’s admin of record)', 'second_brand_admin'],
    ['a second RETAIL_ADMIN (not the retailer’s admin of record)', 'second_retail_admin'],
  ])('%s → 403 USER_MISCONFIGURED', async (_label, userId) => {
    const res = await me(userId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('user of a SUSPENDED brand → 403 BRAND_INACTIVE', async () => {
    const res = await me('admin_suspended');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRAND_INACTIVE');
  });

  it('RETAIL_ADMIN pointing at a store that does not exist → 403 USER_MISCONFIGURED', async () => {
    const world = buildTestWorld();
    const users = (world.users as MemoryUsers).users;
    users.find((u) => u.userId === 'radmin_B')!.storeId = 'store_ghost';
    const res = await request(world.app).get('/api/me').set('Authorization', bearer('radmin_B'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('RETAIL_ADMIN of a retailer whose store record points at another retailer → 403 USER_MISCONFIGURED', async () => {
    const world = buildTestWorld();
    world.world.stores.find((st) => st.storeId === 'store_B')!.retailerId = 'rtl_X';
    const res = await request(world.app).get('/api/me').set('Authorization', bearer('radmin_B'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('a hand-edited user document pointing at another store of the same retailer grants nothing (403)', async () => {
    const world = buildTestWorld();
    (world.users as MemoryUsers).users.find((u) => u.userId === 'radmin_A')!.storeId = 'store_B';
    for (const path of ['/api/me', '/api/retail/stores/store_B', '/api/retail/stores/store_A']) {
      const res = await request(world.app).get(path).set('Authorization', bearer('radmin_A'));
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('USER_MISCONFIGURED');
    }
  });

  it('RETAIL_ADMIN of an INACTIVE retailer → 403 RETAILER_INACTIVE', async () => {
    const res = await me('radmin_off');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RETAILER_INACTIVE');
  });
});

/**
 * Regression guard for the MVP role simplification (docs/00 §11.8, Change 6).
 * These are the ONLY references to the retired role values in the codebase:
 * a users/{uid} document still carrying one must be refused, never mapped.
 */
const RETIRED_ROLES = ['BRAND_MEMBER', 'RETAILER_ADMIN', 'RETAILER_STAFF'];

describe('retired roles are rejected', () => {
  it.each(RETIRED_ROLES)('a user document with role %s → 403 USER_MISCONFIGURED', async (role) => {
    const world = buildTestWorld();
    (world.users as MemoryUsers).users.push({
      userId: `legacy_${role}`,
      role,
      brandId: 'brand_A',
      retailerId: role === 'BRAND_MEMBER' ? null : 'rtl_A',
      storeId: role === 'BRAND_MEMBER' ? null : 'store_A',
      email: null,
      status: 'ACTIVE',
    });
    const res = await request(world.app)
      .get('/api/me')
      .set('Authorization', bearer(`legacy_${role}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
    expect(ROLES as readonly string[]).not.toContain(role);
  });
});
