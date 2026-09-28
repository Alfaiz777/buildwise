import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestWorld } from './helpers.js';

type App = Parameters<typeof request>[0];
const as = (app: App, userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer(userId)).send(body),
  patch: (path: string, body: object) => request(app).patch(path).set('Authorization', bearer(userId)).send(body),
});

describe('BRAND_ADMIN cannot provision another BRAND_ADMIN', () => {
  it('there is no brand-admin provisioning route in the Brand Console API (404)', async () => {
    const { app, users } = buildTestWorld();
    const before = users.users.length;
    const res = await as(app, 'admin_a').post('/api/brand/admins', { email: 'second@a.test' });
    expect(res.status).toBe(404);
    expect(users.users.length).toBe(before);
  });

  it('the brand-administration service has no way to create a BRAND_ADMIN', async () => {
    const { TenantAdminService } = await import('../src/application/tenantAdminService.js');
    const methods = Object.getOwnPropertyNames(TenantAdminService.prototype);
    expect(methods.filter((m) => /brandadmin/i.test(m))).toEqual([]);
  });

  it('GET /api/brand/users is read-only and shows the single Brand Admin and each Retail Admin’s store', async () => {
    const { app } = buildTestWorld();
    const res = await as(app, 'admin_a').get('/api/brand/users');
    expect(res.status).toBe(200);
    const brandAdmins = res.body.users.filter((u: { role: string; user_id: string }) => u.role === 'BRAND_ADMIN');
    expect(brandAdmins.map((u: { user_id: string }) => u.user_id)).toContain('admin_a');
    expect(res.body.users.find((u: { user_id: string }) => u.user_id === 'radmin_B')).toMatchObject({
      role: 'RETAIL_ADMIN',
      retailer_id: 'rtl_A',
      store_id: 'store_B',
    });
  });
});

describe('BRAND_ADMIN: retailers → stores → one RETAIL_ADMIN per store', () => {
  it('creates a retailer (server-generated ID); the action is audited', async () => {
    const { app, audit } = buildTestWorld();
    const res = await as(app, 'admin_a').post('/api/brand/retailers', { name: 'East Retail' });
    expect(res.status).toBe(201);
    expect(res.body.retailer_id).toMatch(/^rtl_[0-9a-f]{16}$/);
    expect(res.body).toEqual({ retailer_id: res.body.retailer_id, name: 'East Retail', status: 'ACTIVE' });
    expect(audit.brandEvents.at(-1)).toMatchObject({ action: 'RETAILER_CREATED', targetId: res.body.retailer_id });
  });

  it('lists the brand’s stores with their retailer and Retail Admin (or none), never another brand’s', async () => {
    const { app } = buildTestWorld();
    const res = await as(app, 'admin_a').get('/api/brand/stores');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.body.stores.map(
        (s: { store_id: string; retailer_id: string | null; retail_admin_user_id: string | null }) => [
          s.store_id,
          [s.retailer_id, s.retail_admin_user_id],
        ],
      ),
    );
    expect(byId).toMatchObject({
      store_A: ['rtl_A', 'radmin_A'],
      store_B: ['rtl_A', 'radmin_B'],
      store_C: ['rtl_A', null],
      store_free: [null, null],
    });
    expect(byId).not.toHaveProperty('store_b1');
  });

  it('provisions the Retail Admin of one store and returns the local password-setup link', async () => {
    const { app, identity, audit, stores, users } = buildTestWorld();
    const res = await as(app, 'admin_a').post('/api/brand/stores/store_C/admins', { email: 'owner-c@a.test' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'RETAIL_ADMIN', email: 'owner-c@a.test' });
    expect(res.body.password_setup_link).toMatch(/^https?:\/\//);
    expect(audit.brandEvents.at(-1)).toMatchObject({ action: 'RETAIL_ADMIN_PROVISIONED' });

    const uid = identity.byEmail.get('owner-c@a.test')!;
    expect((await stores.get('brand_A', 'store_C'))!.retailAdminUserId).toBe(uid);
    expect(users.users.find((u) => u.userId === uid)).toMatchObject({
      brandId: 'brand_A',
      retailerId: 'rtl_A',
      storeId: 'store_C',
    });

    // The new admin operates Store C only — not its retailer's other stores.
    const call = (path: string) => request(app).get(path).set('Authorization', bearer(uid));
    const me = await call('/api/me');
    expect(me.body).toMatchObject({ scope: 'RETAIL', retailer_id: 'rtl_A', store_id: 'store_C' });
    expect(me.body.store.store_id).toBe('store_C');
    expect((await call('/api/retail/stores/store_C')).status).toBe(200);
    expect((await call('/api/retail/stores/store_A')).status).toBe(404);
    expect((await call('/api/retail/stores/store_B')).status).toBe(404);

    // Seeded admins of the same retailer are unaffected.
    expect((await as(app, 'radmin_A').get('/api/retail/stores/store_A')).status).toBe(200);
  });

  it('a second Retail Admin for Store A is rejected (409), and no user or setup link is created', async () => {
    const { app, users, identity } = buildTestWorld();
    const before = users.users.length;
    const res = await as(app, 'admin_a').post('/api/brand/stores/store_A/admins', { email: 'second@a.test' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RETAIL_ADMIN_ALREADY_PROVISIONED');
    expect(res.body).not.toHaveProperty('password_setup_link');
    expect(users.users.length).toBe(before);
    expect(identity.byEmail.has('second@a.test')).toBe(false);

    // Also for a store provisioned in-product.
    expect((await as(app, 'admin_a').post('/api/brand/stores/store_C/admins', { email: 'one@a.test' })).status).toBe(
      201,
    );
    const again = await as(app, 'admin_a').post('/api/brand/stores/store_C/admins', { email: 'two@a.test' });
    expect(again.body.error.code).toBe('RETAIL_ADMIN_ALREADY_PROVISIONED');
  });

  it('a store without a retailer cannot get a Retail Admin (409 STORE_HAS_NO_RETAILER)', async () => {
    const { app, users } = buildTestWorld();
    const before = users.users.length;
    const res = await as(app, 'admin_a').post('/api/brand/stores/store_free/admins', { email: 'x@free.test' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STORE_HAS_NO_RETAILER');
    expect(users.users.length).toBe(before);
  });

  it('ignores any scope chosen by the client: brand, retailer and store come from the store record', async () => {
    const { app, users, identity } = buildTestWorld();
    const res = await as(app, 'admin_a').post('/api/brand/stores/store_C/admins', {
      email: 'x@c.test',
      brand_id: 'brand_B',
      retailer_id: 'rtl_X',
      store_id: 'store_A',
      store_ids: ['store_A', 'store_B'],
    });
    expect(res.status).toBe(201);
    const stored = users.users.find((u) => u.userId === identity.byEmail.get('x@c.test'))!;
    expect(stored).toMatchObject({ brandId: 'brand_A', retailerId: 'rtl_A', storeId: 'store_C' });
    expect(Object.keys(stored)).not.toContain('storeIds');
  });

  it('retailer-wide provisioning does not exist (404)', async () => {
    const { app } = buildTestWorld();
    const res = await as(app, 'admin_a').post('/api/brand/retailers/rtl_A/admins', { email: 'x@a.test' });
    expect(res.status).toBe(404);
  });

  it('cannot see or provision another brand’s store (404)', async () => {
    const { app } = buildTestWorld();
    expect((await as(app, 'admin_a').post('/api/brand/stores/store_b1/admins', { email: 'x@b.test' })).status).toBe(
      404,
    );
  });

  it('validates input', async () => {
    const { app } = buildTestWorld();
    const admin = as(app, 'admin_a');
    expect((await admin.post('/api/brand/retailers', { name: '' })).status).toBe(400);
    expect((await admin.post('/api/brand/stores/store_C/admins', { email: 'nope' })).status).toBe(400);
  });
});

describe('store → retailer association (backend-only until retail ingestion, M4)', () => {
  it('a retailer may own several stores: a free store joins a retailer that already has stores', async () => {
    const { app, audit, stores } = buildTestWorld();
    const res = await as(app, 'admin_a').patch('/api/brand/stores/store_free', { retailer_id: 'rtl_A' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ store_id: 'store_free', retailer_id: 'rtl_A', retail_admin_user_id: null });
    expect(audit.brandEvents.at(-1)).toMatchObject({ action: 'STORE_RETAILER_ASSIGNED', targetId: 'store_free' });
    expect((await stores.list('brand_A')).filter((s) => s.retailerId === 'rtl_A').length).toBe(5);
  });

  it('a store can belong to only one retailer (409 STORE_ALREADY_ASSIGNED)', async () => {
    const { app, stores } = buildTestWorld();
    const res = await as(app, 'admin_a').patch('/api/brand/stores/store_C', { retailer_id: 'rtl_X' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STORE_ALREADY_ASSIGNED');
    expect((await stores.get('brand_A', 'store_C'))!.retailerId).toBe('rtl_A');
  });

  it('a store operated by its Retail Admin cannot be unassigned (409 STORE_HAS_ADMIN)', async () => {
    const { app } = buildTestWorld();
    const res = await as(app, 'admin_a').patch('/api/brand/stores/store_A', { retailer_id: null });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STORE_HAS_ADMIN');
    expect((await as(app, 'radmin_A').get('/api/retail/stores/store_A')).status).toBe(200);
  });

  it('a store without a Retail Admin can be unassigned and re-assigned', async () => {
    const { app, stores } = buildTestWorld();
    const admin = as(app, 'admin_a');
    expect((await admin.patch('/api/brand/stores/store_C', { retailer_id: null })).body.retailer_id).toBeNull();
    expect((await stores.get('brand_A', 'store_C'))!.retailerId).toBeNull();
    expect((await admin.patch('/api/brand/stores/store_C', { retailer_id: 'rtl_X' })).status).toBe(200);
  });

  it('re-assigning a store to its own retailer is a no-op', async () => {
    const { app, audit } = buildTestWorld();
    const before = audit.brandEvents.length;
    expect((await as(app, 'admin_a').patch('/api/brand/stores/store_A', { retailer_id: 'rtl_A' })).status).toBe(200);
    expect(audit.brandEvents.length).toBe(before);
  });

  it('cannot reach another brand’s stores or retailers (404)', async () => {
    const { app } = buildTestWorld();
    const admin = as(app, 'admin_a');
    expect((await admin.patch('/api/brand/stores/store_b1', { retailer_id: 'rtl_A' })).status).toBe(404);
    expect((await admin.patch('/api/brand/stores/store_free', { retailer_id: 'rtl_b' })).status).toBe(404);
  });
});

describe('RETAIL_ADMIN cannot perform brand administration', () => {
  it('every brand-administration route → 403', async () => {
    const { app } = buildTestWorld();
    const retail = as(app, 'radmin_A');
    expect((await retail.get('/api/brand/users')).status).toBe(403);
    expect((await retail.get('/api/brand/stores')).status).toBe(403);
    expect((await retail.post('/api/brand/retailers', { name: 'R' })).status).toBe(403);
    expect((await retail.post('/api/brand/stores/store_C/admins', { email: 'x@a.test' })).status).toBe(403);
    expect((await retail.patch('/api/brand/stores/store_free', { retailer_id: 'rtl_A' })).status).toBe(403);
  });
});
