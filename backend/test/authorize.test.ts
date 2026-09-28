import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { canAccessTenantResource, type TenantResource } from '../src/domain/access.js';
import { ROLES, type Principal } from '../src/domain/principal.js';
import { bearer, buildTestWorld } from './helpers.js';

const { app } = buildTestWorld();
const get = (path: string, userId: string) => request(app).get(path).set('Authorization', bearer(userId));

describe('route authorization by scope', () => {
  it('PLATFORM_ADMIN can access platform routes', async () => {
    expect((await get('/api/platform/brands', 'platform')).status).toBe(200);
  });

  it('PLATFORM_ADMIN is refused (403) on every tenant route', async () => {
    for (const path of [
      '/api/brands/brand_A',
      '/api/brand/users',
      '/api/brand/retailers',
      '/api/retail/stores/store_A',
    ]) {
      const res = await get(path, 'platform');
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('BRAND_ADMIN and RETAIL_ADMIN are refused (403) on every platform route', async () => {
    for (const userId of ['admin_a', 'radmin_A']) {
      expect((await get('/api/platform/brands', userId)).status, userId).toBe(403);
      expect((await get('/api/platform/audit', userId)).status, userId).toBe(403);
    }
  });

  it('RETAIL_ADMIN is refused (403) on brand administration routes', async () => {
    for (const path of ['/api/brand/users', '/api/brand/retailers', '/api/brands/brand_A']) {
      expect((await get(path, 'radmin_A')).status, path).toBe(403);
    }
    const patch = await request(app)
      .patch('/api/brand/stores/store_free')
      .set('Authorization', bearer('radmin_A'))
      .send({ retailer_id: 'rtl_A' });
    expect(patch.status).toBe(403);
  });

  it('BRAND_ADMIN is refused (403) on Retailer Console routes', async () => {
    expect((await get('/api/retail/stores/store_A', 'admin_a')).status).toBe(403);
  });

  it('BRAND_ADMIN can read its own brand profile', async () => {
    const res = await get('/api/brands/brand_A', 'admin_a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ brand_id: 'brand_A', name: 'Brand brand_A', status: 'ACTIVE' });
  });
});

/**
 * The MVP ownership contract, end to end. Both stores belong to the SAME retailer,
 * which proves that retail access is store-level, not retailer-level:
 *   Brand A
 *     └── Retailer A
 *          ├── Store A → RETAIL_ADMIN_A
 *          └── Store B → RETAIL_ADMIN_B
 */
describe('store-level isolation: Brand A / Retailer A → Store A and Store B', () => {
  it('one retailer owns several stores, each with its own Retail Admin', async () => {
    const stores = (await get('/api/brand/stores', 'admin_a')).body.stores as {
      store_id: string;
      retailer_id: string;
      retail_admin_user_id: string | null;
    }[];
    const ofA = stores.filter((s) => s.retailer_id === 'rtl_A');
    expect(ofA.map((s) => s.store_id).sort()).toEqual(['store_A', 'store_B', 'store_C', 'store_M']);
    expect(ofA.find((s) => s.store_id === 'store_A')!.retail_admin_user_id).toBe('radmin_A');
    expect(ofA.find((s) => s.store_id === 'store_B')!.retail_admin_user_id).toBe('radmin_B');
  });

  it('RETAIL_ADMIN_A can access Store A', async () => {
    const res = await get('/api/retail/stores/store_A', 'radmin_A');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ store_id: 'store_A', store_name: 'Store store_A', store_status: 'ACTIVE' });
    expect((await get('/api/me', 'radmin_A')).body.store_id).toBe('store_A');
  });

  it('RETAIL_ADMIN_A cannot access Store B, although both belong to Retailer A (404, nothing leaked)', async () => {
    const res = await get('/api/retail/stores/store_B', 'radmin_A');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('Store store_B');
  });

  it('RETAIL_ADMIN_B can access only Store B', async () => {
    expect((await get('/api/retail/stores/store_B', 'radmin_B')).status).toBe(200);
    expect((await get('/api/retail/stores/store_A', 'radmin_B')).status).toBe(404);
  });

  it('a RETAIL_ADMIN cannot reach an unassigned store, another brand’s store, or a missing store', async () => {
    for (const storeId of ['store_C', 'store_X', 'store_free', 'store_b1', 'store_nope']) {
      expect((await get(`/api/retail/stores/${storeId}`, 'radmin_A')).status, storeId).toBe(404);
    }
    expect((await get('/api/retail/stores/store_A', 'radmin_b')).status).toBe(404);
  });

  it('invalid store IDs (including wildcards) are 404, never a list', async () => {
    for (const storeId of ['ALL', '*', 'ANY']) {
      expect((await get(`/api/retail/stores/${encodeURIComponent(storeId)}`, 'radmin_A')).status, storeId).toBe(404);
    }
  });
});

describe('tenant isolation (out-of-scope → 404 or never listed)', () => {
  it('BRAND_ADMIN gets 404, not 403, for another brand', async () => {
    const res = await get('/api/brands/brand_B', 'admin_a');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Brand brand_B');
    expect((await get('/api/brands/brand_A', 'admin_b')).status).toBe(404);
  });

  it('brand lists never include another brand’s data', async () => {
    const users = await get('/api/brand/users', 'admin_a');
    const ids = users.body.users.map((u: { user_id: string }) => u.user_id);
    expect(ids).toContain('radmin_A');
    expect(ids).toContain('radmin_B');
    expect(ids).not.toContain('admin_b');
    expect(ids).not.toContain('radmin_b');
    const retailers = await get('/api/brand/retailers', 'admin_b');
    expect(retailers.body.retailers.map((r: { retailer_id: string }) => r.retailer_id)).toEqual(['rtl_b']);
  });
});

describe('canAccessTenantResource (pure rule, docs/07 §4.1 step 4)', () => {
  const platform: Principal = { scope: 'PLATFORM', role: 'PLATFORM_ADMIN', userId: 'p', email: null };
  const brandAdmin: Principal = { scope: 'BRAND', role: 'BRAND_ADMIN', userId: 'a', email: null, brandId: 'brand_A' };
  const retailAdminA: Principal = {
    scope: 'RETAIL',
    role: 'RETAIL_ADMIN',
    userId: 'r',
    email: null,
    brandId: 'brand_A',
    retailerId: 'rtl_A',
    storeId: 'store_A',
  };
  const storeA = { brandId: 'brand_A', retailerId: 'rtl_A', storeId: 'store_A' };

  const cases: [string, Principal, TenantResource, boolean][] = [
    ['platform never accesses tenant data', platform, { brandId: 'brand_A' }, false],
    [
      'brand: own brand, any retailer’s store',
      brandAdmin,
      { ...storeA, retailerId: 'rtl_X', storeId: 'store_X' },
      true,
    ],
    ['brand: own brand, unassigned store', brandAdmin, { brandId: 'brand_A', retailerId: null, storeId: 's' }, true],
    ['brand: other brand', brandAdmin, { brandId: 'brand_B' }, false],
    ['retail: its own store', retailAdminA, storeA, true],
    [
      'retail: another retailer’s store, same brand',
      retailAdminA,
      { ...storeA, retailerId: 'rtl_X', storeId: 'store_X' },
      false,
    ],
    ['retail: another store of the SAME retailer', retailAdminA, { ...storeA, storeId: 'store_B' }, false],
    ['retail: unassigned store', retailAdminA, { ...storeA, retailerId: null, storeId: 'store_free' }, false],
    ['retail: brand-level resource (no store)', retailAdminA, { brandId: 'brand_A' }, false],
    ['retail: retailer-level resource (no store)', retailAdminA, { brandId: 'brand_A', retailerId: 'rtl_A' }, false],
    ['retail: same IDs in another brand', retailAdminA, { ...storeA, brandId: 'brand_B' }, false],
  ];

  it.each(cases)('%s', (_label, principal, resource, expected) => {
    expect(canAccessTenantResource(principal, resource)).toBe(expected);
  });
});

describe('Customer AI Channel: the customer is never a console principal', () => {
  it('a users/{uid} document claiming CUSTOMER is refused on every console route (403 USER_MISCONFIGURED)', async () => {
    for (const path of [
      '/api/me',
      '/api/platform/brands',
      '/api/brands/brand_A',
      '/api/brand/retailers',
      '/api/retail/stores/store_A',
    ]) {
      const res = await get(path, 'customer_role');
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('USER_MISCONFIGURED');
    }
  });

  it('CUSTOMER is not a role and has no console scope', () => {
    expect(ROLES as readonly string[]).not.toContain('CUSTOMER');
  });
});

describe('no store-staff model exists in the MVP', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it('there is no store-staff role', () => {
    expect(ROLES).toEqual(['PLATFORM_ADMIN', 'BRAND_ADMIN', 'RETAIL_ADMIN']);
    expect(ROLES.some((r) => /STAFF|MEMBER/.test(r))).toBe(false);
  });

  it('the retail principal carries a single storeId, never a list', async () => {
    const res = await get('/api/me', 'radmin_A');
    expect(typeof res.body.store_id).toBe('string');
    expect(res.body).not.toHaveProperty('stores');
    expect(res.body).not.toHaveProperty('store_ids');
  });

  it('no source file models multi-store users or per-user store lists', () => {
    const offenders = files(SRC).filter((f) => /storeIds|store_ids|STORE_STAFF/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
