import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestWorld } from './helpers.js';

const asPlatform = (app: Parameters<typeof request>[0]) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer('platform')),
  post: (path: string, body: object) => request(app).post(path).set('Authorization', bearer('platform')).send(body),
  patch: (path: string, body: object) => request(app).patch(path).set('Authorization', bearer('platform')).send(body),
});

describe('platform administration (/api/platform/*)', () => {
  it('lists brands (metadata only)', async () => {
    const { app } = buildTestWorld();
    const res = await asPlatform(app).get('/api/platform/brands');
    expect(res.status).toBe(200);
    expect(res.body.brands.map((b: { brand_id: string }) => b.brand_id)).toEqual([
      'brand_A',
      'brand_B',
      'brand_C',
      'brand_S',
    ]);
    expect(Object.keys(res.body.brands[0]).sort()).toEqual([
      'brand_admin_user_id',
      'brand_id',
      'created_at',
      'name',
      'status',
    ]);
    expect(res.body.brands[0].brand_admin_user_id).toBe('admin_a');
    expect(res.body.brands[2].brand_admin_user_id).toBeNull();
  });

  it('creates a brand with a server-generated ID and writes platform + brand audit events', async () => {
    const { app, audit } = buildTestWorld();
    const res = await asPlatform(app).post('/api/platform/brands', {
      name: '  New Brand  ',
      brand_id: 'chosen_by_client',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'New Brand', status: 'ACTIVE' });
    expect(res.body.brand_id).toMatch(/^brd_[0-9a-f]{16}$/);

    expect(audit.platformEvents).toMatchObject([
      { actorId: 'platform', action: 'BRAND_CREATED', targetBrandId: res.body.brand_id, result: 'SUCCESS' },
    ]);
    expect(audit.brandEvents).toMatchObject([
      { brandId: res.body.brand_id, actorType: 'PLATFORM_ADMIN', action: 'BRAND_CREATED' },
    ]);
  });

  it('suspends a brand: its BRAND_ADMIN and RETAIL_ADMINs are refused on their next request; reactivation restores access', async () => {
    const { app, audit } = buildTestWorld();
    expect((await request(app).get('/api/me').set('Authorization', bearer('admin_a'))).status).toBe(200);

    const res = await asPlatform(app).patch('/api/platform/brands/brand_A', {
      status: 'SUSPENDED',
      reason: 'Billing hold',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUSPENDED');
    for (const userId of ['admin_a', 'radmin_A', 'radmin_B']) {
      const me = await request(app).get('/api/me').set('Authorization', bearer(userId));
      expect(me.status, userId).toBe(403);
      expect(me.body.error.code).toBe('BRAND_INACTIVE');
    }
    expect(audit.platformEvents.at(-1)).toMatchObject({ action: 'BRAND_SUSPENDED', reasonCode: 'Billing hold' });

    await asPlatform(app).patch('/api/platform/brands/brand_A', { status: 'ACTIVE' });
    expect((await request(app).get('/api/me').set('Authorization', bearer('admin_a'))).status).toBe(200);
    expect(audit.platformEvents.at(-1)).toMatchObject({ action: 'BRAND_REACTIVATED' });
  });

  it('provisions the brand’s single BRAND_ADMIN, who can then sign in to that brand', async () => {
    const { app, audit, identity, brands } = buildTestWorld();
    const res = await asPlatform(app).post('/api/platform/brands/brand_C/admins', { email: 'New.Admin@Brand-C.test' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'new.admin@brand-c.test', role: 'BRAND_ADMIN' });
    expect(res.body.password_setup_link).toContain('https://');

    const uid = identity.byEmail.get('new.admin@brand-c.test')!;
    expect((await brands.getById('brand_C'))!.brandAdminUserId).toBe(uid);
    const me = await request(app).get('/api/me').set('Authorization', bearer(uid));
    expect(me.body).toMatchObject({ scope: 'BRAND', role: 'BRAND_ADMIN', brand_id: 'brand_C' });

    expect(audit.platformEvents.at(-1)).toMatchObject({
      action: 'BRAND_ADMIN_PROVISIONED',
      targetBrandId: 'brand_C',
      targetType: 'USER',
      targetId: uid,
    });
    expect(audit.brandEvents.at(-1)).toMatchObject({ brandId: 'brand_C', actorType: 'PLATFORM_ADMIN' });
  });

  it('a brand has only one BRAND_ADMIN: a second provisioning is rejected (409), nothing is written', async () => {
    const { app, users, audit } = buildTestWorld();
    expect((await asPlatform(app).post('/api/platform/brands/brand_C/admins', { email: 'one@c.test' })).status).toBe(
      201,
    );
    const usersBefore = users.users.length;
    const auditBefore = audit.platformEvents.length;

    for (const brandId of ['brand_C', 'brand_A']) {
      const res = await asPlatform(app).post(`/api/platform/brands/${brandId}/admins`, { email: 'two@c.test' });
      expect(res.status, brandId).toBe(409);
      expect(res.body.error.code).toBe('BRAND_ADMIN_ALREADY_PROVISIONED');
    }
    expect(users.users.length).toBe(usersBefore);
    expect(audit.platformEvents.length).toBe(auditBefore);
  });

  it('never moves an existing user into another brand (409)', async () => {
    const { app, brands } = buildTestWorld();
    const res = await asPlatform(app).post('/api/platform/brands/brand_C/admins', { email: 'admin_a@example.test' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USER_EXISTS_IN_OTHER_BRAND');
    expect((await brands.getById('brand_C'))!.brandAdminUserId).toBeNull();
  });

  it('exposes the platform audit log, newest first', async () => {
    const { app } = buildTestWorld();
    await asPlatform(app).post('/api/platform/brands', { name: 'One' });
    await asPlatform(app).patch('/api/platform/brands/brand_B', { status: 'SUSPENDED' });
    const res = await asPlatform(app).get('/api/platform/audit?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual(['BRAND_SUSPENDED', 'BRAND_CREATED']);
  });

  it('validates input and hides unknown brands', async () => {
    const { app } = buildTestWorld();
    expect((await asPlatform(app).post('/api/platform/brands', { name: '' })).status).toBe(400);
    expect((await asPlatform(app).patch('/api/platform/brands/brand_A', { status: 'DELETED' })).status).toBe(400);
    expect((await asPlatform(app).patch('/api/platform/brands/nope', { status: 'SUSPENDED' })).status).toBe(404);
    expect((await asPlatform(app).patch('/api/platform/brands/ALL', { status: 'SUSPENDED' })).status).toBe(404);
    expect((await asPlatform(app).post('/api/platform/brands/brand_A/admins', { email: 'not-an-email' })).status).toBe(
      400,
    );
  });

  it('platform responses never contain customer data fields', async () => {
    const { app } = buildTestWorld();
    const body = JSON.stringify((await asPlatform(app).get('/api/platform/brands')).body);
    for (const field of ['customer', 'phone', 'address', 'channel_identities', 'conversation']) {
      expect(body).not.toContain(field);
    }
  });
});
