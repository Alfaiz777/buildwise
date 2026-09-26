import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { assertTenantAccess } from '../src/auth/authorize.js';
import type { Principal } from '../src/auth/types.js';
import { AppError, bearer, buildTestApp } from './helpers.js';

const app = buildTestApp();

describe('auth chain step 3 — route authorization by role', () => {
  it('allows brand roles on GET /api/brands/:brandId for their own brand', async () => {
    for (const userId of ['admin_a', 'marketing_a']) {
      const res = await request(app).get('/api/brands/brand_A').set('Authorization', bearer(userId));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ brand_id: 'brand_A', name: 'Brand A', status: 'ACTIVE' });
    }
  });

  it('forbids retail roles (403)', async () => {
    const res = await request(app).get('/api/brands/brand_A').set('Authorization', bearer('staff_a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('auth chain step 4 — tenant boundary', () => {
  it('returns 404 (not 403) for another brand, revealing nothing', async () => {
    const res = await request(app).get('/api/brands/brand_B').set('Authorization', bearer('admin_a'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('Brand B');
  });

  it('is symmetric: Brand B cannot read Brand A', async () => {
    const res = await request(app).get('/api/brands/brand_A').set('Authorization', bearer('admin_b'));
    expect(res.status).toBe(404);
  });
});

describe('assertTenantAccess', () => {
  const admin: Principal = { userId: 'u1', email: null, brandId: 'brand_A', role: 'BRAND_ADMIN', storeIds: [] };
  const staff: Principal = { userId: 'u2', email: null, brandId: 'brand_A', role: 'RETAIL_STAFF', storeIds: ['store_1'] };

  const status = (fn: () => void) => {
    try {
      fn();
      return 200;
    } catch (err) {
      return (err as AppError).status;
    }
  };

  it('allows a brand user any store in their brand', () => {
    expect(status(() => assertTenantAccess(admin, { brandId: 'brand_A', storeId: 'store_9' }))).toBe(200);
  });

  it('denies a brand user another brand', () => {
    expect(status(() => assertTenantAccess(admin, { brandId: 'brand_B' }))).toBe(404);
  });

  it('allows a retail user only their assigned stores', () => {
    expect(status(() => assertTenantAccess(staff, { brandId: 'brand_A', storeId: 'store_1' }))).toBe(200);
    expect(status(() => assertTenantAccess(staff, { brandId: 'brand_A', storeId: 'store_2' }))).toBe(404);
    expect(status(() => assertTenantAccess(staff, { brandId: 'brand_A' }))).toBe(404);
  });

  it('denies a retail user a same-named store in another brand', () => {
    expect(status(() => assertTenantAccess(staff, { brandId: 'brand_B', storeId: 'store_1' }))).toBe(404);
  });
});
