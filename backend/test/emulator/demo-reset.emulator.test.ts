/**
 * M7 Reset demo on the Firebase emulators with the REAL composition root (DEMO_MODE on):
 * after "Reset demo" the demo brand matches a fresh seed (same document counts and key
 * fields, same clock), another brand is byte-identical, and every refusal holds.
 *
 * Run from the repo root: npm run test:emulator
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { buildContainer } from '../../src/composition/container.js';
import { loadConfig } from '../../src/config/env.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { silentLogger } from '../../src/lib/logger.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const PASSWORD = 'password-123';
const DEMO = 'brd_reset_demo';
const KEEP = 'brd_reset_keep';
const SEED = { type: 'SYSTEM' as const, id: 'seed-test' };
const clock = { t: Date.parse('2026-10-07T06:30:00.000Z') };

let dataDir = '';
let db: ReturnType<typeof initFirebase>['db'];
let auth: ReturnType<typeof initFirebase>['auth'];
let container: ReturnType<typeof buildContainer>;
let app: ReturnType<typeof createApp>;
let appOff: ReturnType<typeof createApp>;
const tokens: Record<string, string> = {};
let n = 0;

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

async function user(email: string, role: string, brandId: string, storeId: string | null = null) {
  const { uid } = await auth.createUser({ email, password: PASSWORD });
  await db.doc(`users/${uid}`).set({
    user_id: uid,
    role,
    brand_id: brandId,
    retailer_id: storeId ? 'rtl_north' : null,
    store_id: storeId,
    email,
    status: 'ACTIVE',
  });
  return uid;
}

async function brand(brandId: string) {
  await db
    .doc(`brands/${brandId}`)
    .set({ brand_id: brandId, name: `Brand ${brandId}`, status: 'ACTIVE', settings: {} });
  for (const [id, name] of [
    ['rtl_north', 'North Retail'],
    ['rtl_pune', 'Pune Retail'],
  ]) {
    await db
      .doc(`brands/${brandId}/retailers/${id}`)
      .set({ retailer_id: id, brand_id: brandId, name, status: 'ACTIVE' });
  }
  await container.demoReset.rebuild(brandId, SEED);
}

/** Every document under brands/{brandId} (one query per collection, messages included), keyed by path. */
async function snapshot(brandId: string): Promise<Record<string, unknown>> {
  const root = db.doc(`brands/${brandId}`);
  const out: Record<string, unknown> = { [root.path]: (await root.get()).data() };
  for (const col of await root.listCollections()) {
    for (const d of (await col.get()).docs) out[d.ref.path] = d.data();
  }
  for (const d of (await db.collectionGroup('messages').get()).docs) {
    if (d.ref.path.startsWith(`${root.path}/`)) out[d.ref.path] = d.data();
  }
  return out;
}

const countsOf = (snap: Record<string, unknown>) => {
  const counts: Record<string, number> = {};
  for (const path of Object.keys(snap)) {
    const parts = path.split('/');
    const key = parts.length > 2 ? parts.filter((_, i) => i >= 2 && i % 2 === 0).join('/') : 'brand';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

const reset = (key: string, target = app) =>
  request(target).post('/api/brand/demo/reset').set('Authorization', `Bearer ${tokens[key]}`);

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'qwikspot-reset-'));
  const env = {
    ...process.env,
    QWIKSPOT_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
    DEMO_BRAND_IDS: DEMO,
  };
  container = buildContainer(loadConfig({ ...env, DEMO_MODE: 'true' }), silentLogger, { now: () => new Date(clock.t) });
  app = createApp(container.appDeps);
  appOff = createApp(
    buildContainer(loadConfig({ ...env, DEMO_MODE: 'false' }), silentLogger, { now: () => new Date(clock.t) }).appDeps,
  );
  ({ auth, db } = initFirebase(PROJECT, loadConfig(env).emulators));

  await brand(DEMO);
  await brand(KEEP);
  const demoAdmin = await user('admin@reset-demo.test', 'BRAND_ADMIN', DEMO);
  await db.doc(`brands/${DEMO}`).update({ brand_admin_user_id: demoAdmin });
  const keepAdmin = await user('admin@reset-keep.test', 'BRAND_ADMIN', KEEP);
  await db.doc(`brands/${KEEP}`).update({ brand_admin_user_id: keepAdmin });
  const andheri = await user('andheri@reset-demo.test', 'RETAIL_ADMIN', DEMO, 'st_north_2');
  await db.doc(`brands/${DEMO}/stores/st_north_2`).update({ retail_admin_user_id: andheri });
  tokens.demo = await signIn('admin@reset-demo.test');
  tokens.keep = await signIn('admin@reset-keep.test');
  tokens.andheri = await signIn('andheri@reset-demo.test');
}, 120_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('Reset demo (Change 14, G4)', () => {
  let seeded: Record<string, unknown> = {};
  let keepBefore: Record<string, unknown> = {};

  it('a judge session leaves conversations, a reservation and changed stock behind', async () => {
    seeded = await snapshot(DEMO);
    keepBefore = await snapshot(KEEP);
    const send = (content: object) =>
      request(app)
        .post('/api/channels/simulator/messages')
        .set('Authorization', `Bearer ${tokens.demo}`)
        .send({ simulator_customer_ref: 'judge_ab12', client_message_id: `cm_${++n}`, content });
    const click = await request(app).post('/api/intents').set('Origin', 'http://localhost:5173').send({
      brand_id: DEMO,
      web_session_id: 'ws_reset_judge_0001',
      visitor_id: 'vis_reset_judge_01',
      client_event_id: 'ce_reset_1',
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
    });
    await send({ type: 'TEXT', text: `${click.body.whatsapp.prefilled_text} I need it today` });
    await send({ type: 'LOCATION', latitude: 19.12, longitude: 72.9 });
    const hold = await send({ type: 'INTERACTIVE_REPLY', option_id: 'hold:st_north_2' });
    expect(hold.body.decision.executed_action?.type).toBe('RESERVATION_CREATED');
    expect(countsOf(await snapshot(DEMO))).not.toEqual(countsOf(seeded));
  }, 60_000);

  it('the demo brand’s Brand Admin resets: the same documents as a fresh seed, stock and admins restored', async () => {
    const res = await reset('demo');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted.reservations).toBeGreaterThan(0);
    const after = await snapshot(DEMO);
    const { brand: _b, auditEvents: auditAfter, ...countsAfter } = countsOf(after);
    const { brand: _s, auditEvents: auditSeeded, ...countsSeeded } = countsOf(seeded);
    expect(countsAfter).toEqual(countsSeeded);
    expect(auditAfter!).toBeGreaterThan(auditSeeded!); // the audit trail is kept and grows

    const stock = after[`brands/${DEMO}/retailInventory/st_north_2__DBC-VCSERUM-30`] as Record<string, unknown>;
    expect(stock).toMatchObject({ quantity: 25, reserved_quantity: 0 });
    expect(after[`brands/${DEMO}/retailInventory/st_north_3__DBC-VCSERUM-30`]).toMatchObject({ quantity: 0 });
    expect((after[`brands/${DEMO}/stores/st_north_2`] as Record<string, unknown>).retail_admin_user_id).toBeTruthy();
    expect((after[`brands/${DEMO}`] as { settings: Record<string, unknown> }).settings).toMatchObject({
      reservation_policy: { hold_minutes: 20 },
    });
    const audit = await db.collection(`brands/${DEMO}/auditEvents`).where('action', '==', 'DEMO_RESET').get();
    expect(audit.docs.filter((d) => d.get('actor_type') === 'USER').map((d) => d.get('result'))).toEqual(['SUCCESS']);
    expect((await db.collection('intentTokens').where('brand_id', '==', DEMO).get()).size).toBe(0);
    expect((await db.collection('webhookReceipts').where('brand_id', '==', DEMO).get()).size).toBe(0);
    // The Retail Admin still signs in to the same store.
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${tokens.andheri}`);
    expect(me.body).toMatchObject({ role: 'RETAIL_ADMIN', store_id: 'st_north_2' });
  }, 120_000);

  it('another brand is byte-identical before and after', async () => {
    expect(await snapshot(KEEP)).toEqual(keepBefore);
  }, 60_000);

  it('refusals: again within a minute 429; another brand 403; a Retail Admin 403; DEMO_MODE off 404', async () => {
    expect((await reset('demo')).status).toBe(429);
    const other = await reset('keep');
    expect([other.status, other.body.error.code]).toEqual([403, 'DEMO_RESET_NOT_ALLOWED']);
    expect((await reset('andheri')).status).toBe(403);
    expect((await reset('demo', appOff)).status).toBe(404);
    expect(await snapshot(KEEP)).toMatchObject(
      Object.fromEntries(Object.entries(keepBefore).filter(([k]) => !k.includes('/auditEvents/'))),
    );
  }, 60_000);
});
