import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestApp } from './helpers.js';

const app = buildTestApp();

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

describe('auth chain step 2 — user / brand / role resolution', () => {
  it('rejects a valid Firebase user with no users/{uid} document (403)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer token-unprovisioned');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_NOT_PROVISIONED');
  });

  it('rejects a disabled user (403)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', bearer('disabled_a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_DISABLED');
  });

  it('rejects an unknown role (403 USER_MISCONFIGURED)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', bearer('badrole_a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('rejects a retail user with no store_ids (403 USER_MISCONFIGURED)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', bearer('storeless_staff_a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('rejects a user whose brand is not ACTIVE (403 BRAND_INACTIVE)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', bearer('admin_suspended'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRAND_INACTIVE');
  });

  it('resolves brand and role from users/{uid} for a valid user', async () => {
    const res = await request(app).get('/api/me').set('Authorization', bearer('admin_a'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { user_id: 'admin_a', email: 'admin_a@example.test', role: 'BRAND_ADMIN', store_ids: [] },
      brand: { brand_id: 'brand_A', name: 'Brand A' },
    });
  });

  it('returns store_ids for a retail user', async () => {
    const res = await request(app).get('/api/me').set('Authorization', bearer('staff_a'));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'RETAIL_STAFF', store_ids: ['store_1'] });
  });

  it('never takes brand_id from the client (query, header or body)', async () => {
    const res = await request(app)
      .get('/api/me?brand_id=brand_B')
      .set('Authorization', bearer('admin_a'))
      .set('X-Brand-Id', 'brand_B')
      .send({ brand_id: 'brand_B' });
    expect(res.status).toBe(200);
    expect(res.body.brand.brand_id).toBe('brand_A');
  });
});
