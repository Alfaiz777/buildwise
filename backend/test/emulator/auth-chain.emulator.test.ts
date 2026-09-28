/**
 * Local end-to-end on the Firebase Auth + Firestore emulators, using the REAL
 * composition root (local profile), real token verification, real Firestore
 * repositories and real password-setup links — no fakes.
 *
 *   PLATFORM_ADMIN → creates a brand → provisions its single BRAND_ADMIN
 *   BRAND_ADMIN    → creates retailers, provisions one RETAIL_ADMIN per store
 *   RETAIL_ADMIN   → operates exactly its one store (a retailer may own many stores)
 *   CUSTOMER       → never a console user (the channel flow arrives in M6)
 *
 * Run from the repo root: npm run test:emulator
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { buildContainer } from '../../src/composition/container.js';
import { loadConfig } from '../../src/config/env.js';
import { tenantCollection } from '../../src/data/tenantPaths.js';
import type { TenantPrincipal } from '../../src/domain/principal.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { silentLogger } from '../../src/lib/logger.js';

const PROJECT = 'demo-buildwise';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const config = loadConfig({ ...process.env, BUILDWISE_PROFILE: 'local', GOOGLE_CLOUD_PROJECT: PROJECT });
const container = buildContainer(config, silentLogger);
const app = createApp(container.appDeps);
const { auth, db } = initFirebase(PROJECT, config.emulators);

const PASSWORD = 'password-123';

async function signIn(email: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    },
  );
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`sign-in failed for ${email}`);
  return body.idToken;
}

/** Stands in for the user opening their password-setup link. */
async function completeSetup(email: string): Promise<string> {
  const { uid } = await auth.getUserByEmail(email);
  await auth.updateUser(uid, { password: PASSWORD });
  return signIn(email);
}

const call = (token: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) => request(app).post(path).set('Authorization', `Bearer ${token}`).send(body),
  patch: (path: string, body: object) => request(app).patch(path).set('Authorization', `Bearer ${token}`).send(body),
});

const tokens: Record<string, string> = {};
let brandId = '';
let northId = '';
let otherRetailerId = '';

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

  // Bootstrap (what seed:platform-admin does): the only user not provisioned in-product.
  const platform = await auth.createUser({ email: 'platform@e2e.test', password: PASSWORD });
  await db.doc(`users/${platform.uid}`).set({
    user_id: platform.uid,
    role: 'PLATFORM_ADMIN',
    brand_id: null,
    retailer_id: null,
    store_id: null,
    email: 'platform@e2e.test',
    status: 'ACTIVE',
  });
  tokens.platform = await signIn('platform@e2e.test');

  // A second, pre-existing brand for isolation checks.
  await db.doc('brands/brd_other').set({ brand_id: 'brd_other', name: 'Other', status: 'ACTIVE', settings: {} });
});

describe('local E2E: provisioning journey across the three internal roles', () => {
  it('PLATFORM_ADMIN signs in with platform scope', async () => {
    const res = await call(tokens.platform!).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scope: 'PLATFORM',
      role: 'PLATFORM_ADMIN',
      user: { user_id: expect.any(String), email: 'platform@e2e.test' },
    });
  });

  it('PLATFORM_ADMIN creates a brand and provisions its first BRAND_ADMIN (real setup link)', async () => {
    const created = await call(tokens.platform!).post('/api/platform/brands', { name: 'E2E Beauty' });
    expect(created.status).toBe(201);
    brandId = created.body.brand_id;

    const admin = await call(tokens.platform!).post(`/api/platform/brands/${brandId}/admins`, {
      email: 'admin@e2e-brand.test',
    });
    expect(admin.status).toBe(201);
    expect(admin.body.password_setup_link).toMatch(/^http/);
    tokens.brandAdmin = await completeSetup('admin@e2e-brand.test');

    const me = await call(tokens.brandAdmin).get('/api/me');
    expect(me.body).toMatchObject({ scope: 'BRAND', role: 'BRAND_ADMIN', brand_id: brandId, brand_name: 'E2E Beauty' });
    const { uid } = await auth.getUserByEmail('admin@e2e-brand.test');
    expect((await db.doc(`brands/${brandId}`).get()).get('brand_admin_user_id')).toBe(uid);
  });

  it('a brand has exactly one BRAND_ADMIN: a second one is rejected, and the Brand Admin cannot add one', async () => {
    const second = await call(tokens.platform!).post(`/api/platform/brands/${brandId}/admins`, {
      email: 'second@e2e-brand.test',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BRAND_ADMIN_ALREADY_PROVISIONED');
    expect((await db.collection('users').where('email', '==', 'second@e2e-brand.test').get()).size).toBe(0);

    const selfService = await call(tokens.brandAdmin!).post('/api/brand/admins', { email: 'third@e2e-brand.test' });
    expect(selfService.status).toBe(404);
  });

  it('platform actions are persisted as PlatformAuditEvents and mirrored into the brand', async () => {
    const platformEvents = await db.collection('platformAuditEvents').where('target_brand_id', '==', brandId).get();
    expect(platformEvents.docs.map((d) => d.get('action')).sort()).toEqual([
      'BRAND_ADMIN_PROVISIONED',
      'BRAND_CREATED',
    ]);
    const brandEvents = await db.collection(`brands/${brandId}/auditEvents`).get();
    expect(brandEvents.size).toBe(2);
    expect(brandEvents.docs.every((d) => d.get('actor_type') === 'PLATFORM_ADMIN')).toBe(true);

    const audit = await call(tokens.platform!).get('/api/platform/audit');
    expect(audit.body.events[0]).toMatchObject({ action: 'BRAND_ADMIN_PROVISIONED', target_brand_id: brandId });
  });

  it('BRAND_ADMIN creates Retailer A with Store A and Store B and provisions one RETAIL_ADMIN per store', async () => {
    northId = (await call(tokens.brandAdmin!).post('/api/brand/retailers', { name: 'Retailer A' })).body.retailer_id;
    otherRetailerId = (await call(tokens.brandAdmin!).post('/api/brand/retailers', { name: 'Retailer X' })).body
      .retailer_id;
    expect(northId).toMatch(/^rtl_/);

    // Stores normally come from retail ingestion (M4); seeded directly here.
    for (const storeId of ['st_a', 'st_b', 'st_free']) {
      await db.doc(`brands/${brandId}/stores/${storeId}`).set({
        store_id: storeId,
        brand_id: brandId,
        retailer_id: null,
        store_name: `Store ${storeId}`,
        city: 'Mumbai',
        address: `${storeId} street`,
        store_status: 'ACTIVE',
        store_hours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
      });
    }

    // A store without a retailer cannot get a Retail Admin.
    const early = await call(tokens.brandAdmin!).post('/api/brand/stores/st_a/admins', { email: 'early@e2e.test' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('STORE_HAS_NO_RETAILER');

    // One retailer, several stores.
    for (const storeId of ['st_a', 'st_b']) {
      expect(
        (await call(tokens.brandAdmin!).patch(`/api/brand/stores/${storeId}`, { retailer_id: northId })).status,
      ).toBe(200);
    }
    // A store belongs to exactly one retailer.
    const taken = await call(tokens.brandAdmin!).patch('/api/brand/stores/st_a', { retailer_id: otherRetailerId });
    expect(taken.body.error.code).toBe('STORE_ALREADY_ASSIGNED');

    for (const [storeId, email] of [
      ['st_a', 'owner-a@e2e.test'],
      ['st_b', 'owner-b@e2e.test'],
    ] as const) {
      const res = await call(tokens.brandAdmin!).post(`/api/brand/stores/${storeId}/admins`, { email });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('RETAIL_ADMIN');
      expect(res.body.password_setup_link).toMatch(/^http/);
    }
    tokens.adminA = await completeSetup('owner-a@e2e.test');
    tokens.adminB = await completeSetup('owner-b@e2e.test');
    const { uid: uidA } = await auth.getUserByEmail('owner-a@e2e.test');
    expect((await db.doc(`users/${uidA}`).get()).data()).toMatchObject({ retailer_id: northId, store_id: 'st_a' });
    expect((await db.doc(`brands/${brandId}/stores/st_a`).get()).get('retail_admin_user_id')).toBe(uidA);

    // At most one RETAIL_ADMIN per store.
    const second = await call(tokens.brandAdmin!).post('/api/brand/stores/st_a/admins', {
      email: 'deputy@e2e.test',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('RETAIL_ADMIN_ALREADY_PROVISIONED');
    expect(second.body).not.toHaveProperty('password_setup_link');

    // A store operated by its Retail Admin cannot be detached.
    const detach = await call(tokens.brandAdmin!).patch('/api/brand/stores/st_a', { retailer_id: null });
    expect(detach.body.error.code).toBe('STORE_HAS_ADMIN');

    const stores = await call(tokens.brandAdmin!).get('/api/brand/stores');
    const byId = Object.fromEntries(
      stores.body.stores.map((st: { store_id: string; retailer_id: string; retail_admin_user_id: string | null }) => [
        st.store_id,
        [st.retailer_id, st.retail_admin_user_id],
      ]),
    );
    expect(byId).toMatchObject({ st_a: [northId, uidA], st_free: [null, null] });

    const brandUsers = await call(tokens.brandAdmin!).get('/api/brand/users');
    expect(brandUsers.body.users.map((u: { role: string }) => u.role).sort()).toEqual([
      'BRAND_ADMIN',
      'RETAIL_ADMIN',
      'RETAIL_ADMIN',
    ]);
  });

  it('same retailer, two stores: RETAIL_ADMIN_A can access only Store A, RETAIL_ADMIN_B only Store B', async () => {
    const a = await call(tokens.adminA!).get('/api/me');
    expect(a.body).toMatchObject({
      scope: 'RETAIL',
      role: 'RETAIL_ADMIN',
      brand_id: brandId,
      retailer_id: northId,
      store_id: 'st_a',
      store: { store_id: 'st_a', store_name: 'Store st_a', address: 'st_a street' },
    });
    expect(a.body).not.toHaveProperty('stores');
    expect((await call(tokens.adminB!).get('/api/me')).body).toMatchObject({ retailer_id: northId, store_id: 'st_b' });

    expect((await call(tokens.adminA!).get('/api/retail/stores/st_a')).status).toBe(200);
    expect((await call(tokens.adminA!).get('/api/retail/stores/st_b')).status).toBe(404);
    expect((await call(tokens.adminA!).get('/api/retail/stores/st_free')).status).toBe(404);
    expect((await call(tokens.adminB!).get('/api/retail/stores/st_b')).status).toBe(200);
    expect((await call(tokens.adminB!).get('/api/retail/stores/st_a')).status).toBe(404);
  });

  it('a hand-edited users/{uid} that does not match the store’s recorded admin is refused (403)', async () => {
    const { uid } = await auth.getUserByEmail('owner-a@e2e.test');
    await db.doc(`users/${uid}`).update({ store_id: 'st_b' });
    const forged = await call(tokens.adminA!).get('/api/retail/stores/st_b');
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('USER_MISCONFIGURED');
    await db.doc(`users/${uid}`).update({ store_id: 'st_a' });
    expect((await call(tokens.adminA!).get('/api/me')).status).toBe(200);

    // A second, hand-made RETAIL_ADMIN for Store A is not the store's admin of record.
    const { uid: rogue } = await auth.createUser({ email: 'rogue@e2e.test', password: PASSWORD });
    await db.doc(`users/${rogue}`).set({
      user_id: rogue,
      role: 'RETAIL_ADMIN',
      brand_id: brandId,
      retailer_id: northId,
      store_id: 'st_a',
      email: 'rogue@e2e.test',
      status: 'ACTIVE',
    });
    const res = await call(await signIn('rogue@e2e.test')).get('/api/retail/stores/st_a');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('scope isolation holds with real data', async () => {
    expect((await call(tokens.platform!).get(`/api/brands/${brandId}`)).status).toBe(403);
    expect((await call(tokens.platform!).get('/api/brand/users')).status).toBe(403);
    expect((await call(tokens.brandAdmin!).get('/api/brands/brd_other')).status).toBe(404);
    expect((await call(tokens.brandAdmin!).get('/api/platform/brands')).status).toBe(403);
    expect((await call(tokens.adminA!).get('/api/brand/users')).status).toBe(403);
    expect((await call(tokens.adminA!).get('/api/platform/brands')).status).toBe(403);
    expect((await call(tokens.brandAdmin!).get('/api/retail/stores/st_a')).status).toBe(403);
  });

  it('suspending the brand refuses its BRAND_ADMIN and RETAIL_ADMINs', async () => {
    expect(
      (await call(tokens.platform!).patch(`/api/platform/brands/${brandId}`, { status: 'SUSPENDED' })).status,
    ).toBe(200);
    for (const key of ['brandAdmin', 'adminA', 'adminB']) {
      expect((await call(tokens[key]!).get('/api/me')).status, key).toBe(403);
    }
    await call(tokens.platform!).patch(`/api/platform/brands/${brandId}`, { status: 'ACTIVE' });
    expect((await call(tokens.adminA!).get('/api/me')).status).toBe(200);
  });
});

describe('customers are never console users', () => {
  it('a Firebase user whose users/{uid} says CUSTOMER is refused on every console route (403)', async () => {
    const { uid } = await auth.createUser({ email: 'shopper@e2e.test', password: PASSWORD });
    await db.doc(`users/${uid}`).set({ role: 'CUSTOMER', brand_id: brandId, retailer_id: null, status: 'ACTIVE' });
    const token = await signIn('shopper@e2e.test');
    for (const path of ['/api/me', `/api/brands/${brandId}`, '/api/platform/brands']) {
      const res = await call(token).get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('USER_MISCONFIGURED');
    }
  });
});

describe('auth failures with real tokens', () => {
  it('rejects a tampered token (401)', async () => {
    const tampered = `${tokens.platform!.slice(0, -4)}AAAA`;
    expect((await request(app).get('/api/me').set('Authorization', `Bearer ${tampered}`)).status).toBe(401);
  });

  it('rejects a real Firebase user who is not provisioned (403)', async () => {
    await auth.createUser({ email: 'stranger@e2e.test', password: PASSWORD });
    const res = await call(await signIn('stranger@e2e.test')).get('/api/me');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_NOT_PROVISIONED');
  });

  it('treats a malformed or wildcard users/{uid} document as misconfigured (403)', async () => {
    for (const [email, doc] of [
      ['malformed@e2e.test', { role: 'BRAND_ADMIN' }],
      ['wildcard@e2e.test', { role: 'BRAND_ADMIN', brand_id: 'ALL', status: 'ACTIVE' }],
    ] as const) {
      const { uid } = await auth.createUser({ email, password: PASSWORD });
      await db.doc(`users/${uid}`).set(doc);
      const res = await call(await signIn(email)).get('/api/me');
      expect(res.body.error.code, email).toBe('USER_MISCONFIGURED');
    }
  });
});

describe('Firestore security rules', () => {
  it('deny a signed-in browser client reading Firestore directly, even its own user document', async () => {
    const { uid } = await auth.getUserByEmail('admin@e2e-brand.test');
    const res = await fetch(`http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}`, {
      headers: { Authorization: `Bearer ${tokens.brandAdmin}` },
    });
    expect(res.status).toBe(403);
  });

  it('deny a signed-in browser client writing Firestore directly', async () => {
    const res = await fetch(
      `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/brands/${brandId}/customers?documentId=x`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.brandAdmin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { name: { stringValue: 'injected' } } }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('tenantPaths', () => {
  it('builds tenant collection paths from a tenant principal only', () => {
    const principal: TenantPrincipal = {
      scope: 'RETAIL',
      role: 'RETAIL_ADMIN',
      userId: 'u',
      email: null,
      brandId: 'brand_A',
      retailerId: 'rtl_1',
      storeId: 'store_1',
    };
    expect(tenantCollection(db, principal, 'retailers').path).toBe('brands/brand_A/retailers');
  });
});
