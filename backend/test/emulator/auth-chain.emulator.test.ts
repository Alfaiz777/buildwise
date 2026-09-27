/**
 * Full auth chain against the Firebase Auth + Firestore emulators, using the real
 * FirebaseTokenVerifier and Firestore repositories (no fakes).
 * Run from the repo root: npm run test:emulator
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { FirebaseTokenVerifier } from '../../src/auth/tokenVerifier.js';
import type { Principal } from '../../src/auth/types.js';
import { tenantCollection } from '../../src/data/tenantPaths.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { silentLogger } from '../../src/lib/logger.js';
import { FirestoreBrandRepository, FirestoreUserRepository } from '../../src/repositories/firestore.js';

const PROJECT = 'demo-buildwise';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (use npm run test:emulator)',
  );
}

const { auth, db } = initFirebase(PROJECT);
const app = createApp({
  config: { corsAllowedOrigins: [] },
  logger: silentLogger,
  verifier: new FirebaseTokenVerifier(auth),
  users: new FirestoreUserRepository(db),
  brands: new FirestoreBrandRepository(db),
});

async function signIn(email: string, password: string): Promise<{ idToken: string; uid: string }> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = (await res.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, uid: body.localId };
}

async function createAndSignIn(email: string) {
  await auth.createUser({ email, password: 'password-123' });
  return signIn(email, 'password-123');
}

let adminA: { idToken: string; uid: string };
let unprovisioned: { idToken: string; uid: string };
let malformed: { idToken: string; uid: string };

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

  await db.doc('brands/brand_A').set({ brand_id: 'brand_A', name: 'Brand A', status: 'ACTIVE', settings: {} });
  await db.doc('brands/brand_B').set({ brand_id: 'brand_B', name: 'Brand B', status: 'ACTIVE', settings: {} });

  adminA = await createAndSignIn('admin-a@example.test');
  await db.doc(`users/${adminA.uid}`).set({
    user_id: adminA.uid,
    brand_id: 'brand_A',
    role: 'BRAND_ADMIN',
    store_ids: [],
    email: 'admin-a@example.test',
    status: 'ACTIVE',
  });

  unprovisioned = await createAndSignIn('stranger@example.test');

  malformed = await createAndSignIn('malformed@example.test');
  await db.doc(`users/${malformed.uid}`).set({ role: 'BRAND_ADMIN', status: 'ACTIVE' }); // no brand_id
});

describe('auth chain against emulators', () => {
  it('verifies a real Firebase ID token and resolves the user from Firestore', async () => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${adminA.idToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { user_id: adminA.uid, email: 'admin-a@example.test', role: 'BRAND_ADMIN', store_ids: [] },
      brand: { brand_id: 'brand_A', name: 'Brand A' },
    });
  });

  it('rejects a tampered token (401)', async () => {
    const tampered = `${adminA.idToken.slice(0, -4)}AAAA`;
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it('rejects a real Firebase user who is not provisioned (403)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${unprovisioned.idToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_NOT_PROVISIONED');
  });

  it('treats a malformed users/{uid} document as misconfigured (403)', async () => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${malformed.idToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_MISCONFIGURED');
  });

  it('keeps the tenant boundary with real data (404 for another brand)', async () => {
    const own = await request(app).get('/api/brands/brand_A').set('Authorization', `Bearer ${adminA.idToken}`);
    expect(own.status).toBe(200);
    const other = await request(app).get('/api/brands/brand_B').set('Authorization', `Bearer ${adminA.idToken}`);
    expect(other.status).toBe(404);
  });
});

describe('Firestore security rules', () => {
  it('deny a signed-in browser client reading Firestore directly, even its own user document', async () => {
    const res = await fetch(
      `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users/${adminA.uid}`,
      { headers: { Authorization: `Bearer ${adminA.idToken}` } },
    );
    expect(res.status).toBe(403);
  });

  it('deny a signed-in browser client writing Firestore directly', async () => {
    const res = await fetch(
      `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/brands/brand_A/customers?documentId=x`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminA.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { name: { stringValue: 'injected' } } }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('tenantPaths', () => {
  it('builds tenant collection paths from the principal only', () => {
    const principal: Principal = { userId: 'u', email: null, brandId: 'brand_A', role: 'BRAND_ADMIN', storeIds: [] };
    expect(tenantCollection(db, principal, 'reservations').path).toBe('brands/brand_A/reservations');
  });
});
