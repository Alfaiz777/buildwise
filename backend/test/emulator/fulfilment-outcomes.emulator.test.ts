/**
 * M6 local end-to-end on the Firebase Auth + Firestore emulators with the REAL composition
 * root (local profile, MockAgentRuntime): store fulfilment, customer notifications,
 * refusal forward dispatch, outcomes (OFFLINE / ONLINE / NONE), bw_ref attribution, the
 * handoff queue and the Outcomes screen with and without synthetic history.
 *
 * Run from the repo root: npm run test:emulator
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { buildContainer } from '../../src/composition/container.js';
import { loadConfig } from '../../src/config/env.js';
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

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'password-123';
const A = 'brd_m6'; // scenarios 1–3, 8, 9
const B = 'brd_m6b'; // scenarios 4–7 (the simulator allows 30 messages/min per Brand Admin)
const NEAR_POWAI = { latitude: 19.12, longitude: 72.9 };
const NEAR_BANDRA = { latitude: 19.06, longitude: 72.83 };

const clock = { t: Date.parse('2026-10-07T06:30:00.000Z') }; // Wednesday 12:00 in Mumbai
const advanceMinutes = (m: number) => (clock.t += m * 60_000);

let app: ReturnType<typeof createApp>;
let container: ReturnType<typeof buildContainer>;
let db: ReturnType<typeof initFirebase>['db'];
let auth: ReturnType<typeof initFirebase>['auth'];
let dataDir = '';
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

const as = (key: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${tokens[key]}`),
  post: (path: string, body: object = {}) =>
    request(app).post(path).set('Authorization', `Bearer ${tokens[key]}`).send(body),
  patch: (path: string, body: object = {}) =>
    request(app).patch(path).set('Authorization', `Bearer ${tokens[key]}`).send(body),
  put: (path: string, body: Buffer) =>
    request(app).put(path).set('Authorization', `Bearer ${tokens[key]}`).set('Content-Type', 'text/csv').send(body),
});

async function seedBrand(brandId: string, key: string) {
  const email = `admin@${brandId}.test`;
  const { uid } = await auth.createUser({ email, password: PASSWORD });
  await db.doc(`brands/${brandId}`).set({
    brand_id: brandId,
    name: `Brand ${brandId}`,
    status: 'ACTIVE',
    brand_admin_user_id: uid,
    settings: {
      allowed_storefront_origins: [ORIGIN],
      human_handoff_rules: { enabled: true },
      messaging: { display_name: 'Demo Beauty Co', whatsapp_number: '910000000009' },
      reservation_policy: { reservations_enabled: true, hold_minutes: 120, max_quantity_per_reservation: 2 },
      online_store: { product_url_template: 'http://localhost:5173/demo-store#product={product_id}' },
      outcome_policy: { attribution_window_minutes: 30 },
    },
  });
  await db.doc(`users/${uid}`).set({
    user_id: uid,
    role: 'BRAND_ADMIN',
    brand_id: brandId,
    retailer_id: null,
    store_id: null,
    email,
    status: 'ACTIVE',
  });
  for (const id of ['rtl_north', 'rtl_pune']) {
    await db.doc(`brands/${brandId}/retailers/${id}`).set({
      retailer_id: id,
      brand_id: brandId,
      name: id === 'rtl_north' ? 'North Retail' : 'Pune Retail',
      status: 'ACTIVE',
    });
  }
  tokens[key] = await signIn(email);
  expect((await as(key).post('/api/integrations/shopify/sync')).status).toBe(200);
  const created = await as(key).post('/api/brand/retail-imports', { file_name: 'demo-retail.csv' });
  const csv = await readFile(new URL('../../fixtures/retail/demo-retail.csv', import.meta.url));
  expect((await as(key).put(created.body.upload.url, csv)).status).toBe(200);
  expect((await as(key).post(`/api/brand/retail-imports/${created.body.import.import_id}/process`)).body.status).toBe(
    'COMPLETED',
  );
}

async function retailAdmin(brandKey: string, storeId: string, email: string, key: string) {
  expect((await as(brandKey).post(`/api/brand/stores/${storeId}/admins`, { email })).status).toBe(201);
  const { uid } = await auth.getUserByEmail(email);
  await auth.updateUser(uid, { password: PASSWORD });
  tokens[key] = await signIn(email);
}

const customer = (brandKey: string, brandId: string, ref: string) => {
  const send = (content: object, id = `cm_${++n}`) =>
    as(brandKey).post('/api/channels/simulator/messages', {
      simulator_customer_ref: ref,
      client_message_id: id,
      content,
    });
  return {
    say: (text: string) => send({ type: 'TEXT', text }),
    share: (p: { latitude: number; longitude: number }) => send({ type: 'LOCATION', ...p }),
    tap: (optionId: string) => send({ type: 'INTERACTIVE_REPLY', option_id: optionId }),
    fromStore: async (text: string) => {
      const click = await request(app)
        .post('/api/intents')
        .set('Origin', ORIGIN)
        .send({
          brand_id: brandId,
          web_session_id: `ws_${ref}_${++n}_0000000`,
          visitor_id: `vis_${ref}_00000000`,
          client_event_id: `ce_${++n}`,
          event_type: 'WHATSAPP_CLICK',
          entry: 'STORE_NEED',
          shopify_variant_id: 'gid://shopify/ProductVariant/2001',
        });
      return send({ type: 'TEXT', text: `${click.body.whatsapp.prefilled_text} ${text}` });
    },
  };
};

type Customer = ReturnType<typeof customer>;

/** A hold at `storeId` from `point`; returns the reservation id and pickup code. */
async function hold(c: Customer, brandId: string, point: { latitude: number; longitude: number }, storeId: string) {
  await c.fromStore('I need it today');
  const offer = await c.share(point);
  expect(offer.body.outbound_messages[0].options.map((o: { option_id: string }) => o.option_id)).toContain(
    `hold:${storeId}`,
  );
  const res = await c.tap(`hold:${storeId}`);
  const id = res.body.decision.executed_action.reservation_id as string;
  const doc = (await db.doc(`brands/${brandId}/reservations/${id}`).get()).data()!;
  return { id, pickupCode: doc.pickup_code as string, conversationId: res.body.conversation_id as string };
}

const stock = async (brandId: string, storeId: string, sku = 'DBC-VCSERUM-30') =>
  (await db.doc(`brands/${brandId}/retailInventory/${storeId}__${sku}`).get()).data()!;

async function messages(brandId: string, conversationId: string) {
  const snap = await db
    .collection(`brands/${brandId}/conversations/${conversationId}/messages`)
    .orderBy('message_id')
    .get();
  return snap.docs.map((d) => d.data());
}
const lastUpdate = async (brandId: string, conversationId: string) =>
  (await messages(brandId, conversationId)).filter((m) => m.origin === 'RESERVATION_UPDATE').at(-1)!;

const move = (key: string, id: string, status: string, from: string, extra: object = {}) =>
  as(key).patch(`/api/reservations/${id}`, { status, expected_current_status: from, ...extra });

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'buildwise-m6-'));
  const config = loadConfig({
    ...process.env,
    BUILDWISE_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
  });
  container = buildContainer(config, silentLogger, { now: () => new Date(clock.t) });
  app = createApp(container.appDeps);
  ({ auth, db } = initFirebase(PROJECT, config.emulators));
  await seedBrand(A, 'a');
  await seedBrand(B, 'b');
  await retailAdmin('a', 'st_north_2', 'andheri@m6.test', 'andheri');
  await retailAdmin('a', 'st_north_1', 'bandra@m6.test', 'bandra');
  await retailAdmin('b', 'st_north_2', 'andheri@m6b.test', 'andheriB');
}, 90_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('M6 E2E — store fulfilment, notifications, outcomes', () => {
  it('1+2 · reserve → queue → confirmed → ready → arrived → wrong code 422 → right code → OFFLINE, stock drops', async () => {
    const asha = customer('a', A, 'asha');
    const { id, pickupCode, conversationId } = await hold(asha, A, NEAR_POWAI, 'st_north_2');
    expect(await stock(A, 'st_north_2')).toMatchObject({ quantity: 5, reserved_quantity: 1 });

    const queue = await as('andheri').get('/api/reservations?view=active');
    expect(queue.body.reservations).toEqual([expect.objectContaining({ reservation_id: id, status: 'PENDING' })]);
    expect((await as('bandra').get('/api/reservations?view=active')).body.reservations).toEqual([]);
    expect((await move('bandra', id, 'CONFIRMED', 'PENDING')).status).toBe(404); // same retailer, other store
    expect((await move('a', id, 'CONFIRMED', 'PENDING')).status).toBe(403); // the brand views only

    const confirmed = await move('andheri', id, 'CONFIRMED', 'PENDING');
    expect(confirmed.body).toMatchObject({
      status: 'CONFIRMED',
      notification: { status: 'SENT', message_kind: 'SESSION' },
    });
    expect((await lastUpdate(A, conversationId)).text).toContain(
      `Andheri Store has confirmed your reservation for Vitamin C Glow Serum 30 ml. Pickup code ${pickupCode}`,
    );

    await move('andheri', id, 'READY', 'CONFIRMED');
    const ready = (await lastUpdate(A, conversationId)).text as string;
    expect(ready).toContain(`is ready at Andheri Store. Show code ${pickupCode}.`);
    expect(ready).toContain('https://www.google.com/maps/search/?api=1&query=19.1364,72.8296');
    expect((await move('andheri', id, 'READY', 'CONFIRMED')).body.error.code).toBe('STALE_STATUS');
    await move('andheri', id, 'CUSTOMER_ARRIVED', 'READY');

    const wrong = await move('andheri', id, 'COMPLETED', 'CUSTOMER_ARRIVED', {
      pickup_code: pickupCode === '000000' ? '111111' : '000000',
    });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'PICKUP_CODE_MISMATCH']);
    expect((await db.doc(`brands/${A}/reservations/${id}`).get()).data()).toMatchObject({
      status: 'CUSTOMER_ARRIVED',
      pickup_code_attempts: 1,
    });
    expect(await stock(A, 'st_north_2')).toMatchObject({ quantity: 5, reserved_quantity: 1 });

    const done = await move('andheri', id, 'COMPLETED', 'CUSTOMER_ARRIVED', { pickup_code: pickupCode });
    expect(done.status).toBe(200);
    expect(await stock(A, 'st_north_2')).toMatchObject({ quantity: 4, reserved_quantity: 0 });
    const outcomes = (await db.collection(`brands/${A}/outcomes`).where('reservation_id', '==', id).get()).docs.map(
      (d) => d.data(),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({
        purchase_type: 'OFFLINE',
        evidence: 'RESERVATION_COMPLETED',
        store_id: 'st_north_2',
        value: 795,
      }),
    ]);
    const outcomeEvents = await db
      .collection(`brands/${A}/commerceEvents`)
      .where('event_type', '==', 'OUTCOME_RECORDED')
      .get();
    expect(outcomeEvents.size).toBe(1);
  }, 60_000);

  it('3 · refusal NOT_ACTUALLY_IN_STOCK → apology + hold at the next store → tap → new reservation; the refusing store shows unavailable', async () => {
    const ravi = customer('a', A, 'ravi_m6');
    const { id, conversationId } = await hold(ravi, A, NEAR_BANDRA, 'st_north_1');
    const refused = await move('bandra', id, 'CANCELLED', 'PENDING', { cancel_reason: 'NOT_ACTUALLY_IN_STOCK' });
    expect(refused.body).toMatchObject({
      status: 'CANCELLED',
      cancelled_by: 'RETAILER',
      notification: { status: 'SENT', event: 'REFUSED' },
    });
    const message = await lastUpdate(A, conversationId);
    expect(message.text).toMatch(/^Sorry — Bandra Store can't fulfil your reservation/);
    expect(message.options.map((o: { option_id: string }) => o.option_id)).toEqual(['hold:st_north_2', 'buy_online']);
    const bandra = await stock(A, 'st_north_1');
    expect(bandra.quantity).toBe(bandra.reserved_quantity); // available 0
    expect(bandra.availability_status).toBe('OUT_OF_STOCK');
    const retail = await as('bandra').get('/api/retail/stores/st_north_1/inventory');
    expect(retail.body.items.find((i: { sku: string }) => i.sku === 'DBC-VCSERUM-30')).toMatchObject({
      available_quantity: 0,
    });

    const tap = await ravi.tap('hold:st_north_2');
    expect(tap.body.decision.executed_action.type).toBe('RESERVATION_CREATED');
    const again = (
      await db.doc(`brands/${A}/reservations/${tap.body.decision.executed_action.reservation_id}`).get()
    ).data()!;
    expect(again).toMatchObject({ store_id: 'st_north_2', status: 'PENDING' });
  }, 60_000);

  it('9 · an opted-out customer is not notified; the store sees it', async () => {
    const meera = customer('a', A, 'meera_m6');
    const { id } = await hold(meera, A, NEAR_POWAI, 'st_north_2');
    await meera.say('STOP');
    const res = await move('andheri', id, 'CONFIRMED', 'PENDING');
    expect(res.body.notification).toMatchObject({ status: 'NOT_SENT_OPTED_OUT' });
    const card = (await as('andheri').get('/api/reservations?view=active')).body.reservations.find(
      (r: { reservation_id: string }) => r.reservation_id === id,
    );
    expect(card.last_notification).toMatchObject({ status: 'NOT_SENT_OPTED_OUT', event: 'CONFIRMED' });
  }, 60_000);

  it('4 · a refusal when no other store qualifies → online / alternative and UNMET_DEMAND', async () => {
    const neha = customer('b', B, 'neha_m6');
    const { id, conversationId } = await hold(neha, B, NEAR_POWAI, 'st_north_2');
    await move('andheriB', id, 'CANCELLED', 'PENDING', { cancel_reason: 'DAMAGED' });
    const message = await lastUpdate(B, conversationId);
    expect(message.text).toContain(
      "Vitamin C Glow Serum 30 ml isn't available for pickup at a store near you right now.",
    );
    expect(message.options.map((o: { option_id: string }) => o.option_id)).toContain('buy_online');
    expect(message.options.map((o: { option_id: string }) => o.option_id)).not.toContain('hold:st_north_2');
    const events = await db
      .collection(`brands/${B}/commerceEvents`)
      .where('event_type', '==', 'STORE_RECOMMENDATION')
      .get();
    expect(events.docs.some((d) => d.get('payload').kind === 'UNMET_DEMAND' && d.get('entity_reference') === id)).toBe(
      true,
    );
  }, 60_000);

  it('5 · Buy online → bw_ref → demo storefront order → ONLINE outcome linked to the recommendation', async () => {
    const om = customer('b', B, 'om_m6');
    await om.fromStore('hi');
    await om.share(NEAR_POWAI);
    const online = await om.tap('buy_online');
    const ref = /bw_ref=([0-9A-Z]{26})/.exec(online.body.outbound_messages[0].text)![1];
    expect(online.body.outbound_messages[0].text).toContain(
      `http://localhost:5173/demo-store?bw_ref=${ref}#product=prd_1001`,
    );
    const order = await request(app).post('/api/demo-storefront/orders').set('Origin', ORIGIN).send({
      brand_id: B,
      web_session_id: 'ws_om_m6_landing_01',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
      bw_ref: ref,
    });
    expect(order.body).toMatchObject({ attributed: true, outcome_recorded: true });
    const outcome = (
      await db.collection(`brands/${B}/outcomes`).where('evidence', '==', 'ORDER').get()
    ).docs[0]!.data();
    expect(outcome).toMatchObject({
      purchase_type: 'ONLINE',
      ai_recommendation_id: online.body.decision.recommendation_id,
      value: 795,
    });
    const refs = await db.collection(`brands/${B}/attributionRefs`).get();
    expect(refs.docs.some((d) => d.id.includes(ref!))).toBe(false); // only the hash is stored
  }, 60_000);

  it('6 · a hold expires and nothing is bought → expiry notice; NONE only after the attribution window', async () => {
    const zoya = customer('b', B, 'zoya_m6');
    const { conversationId } = await hold(zoya, B, NEAR_POWAI, 'st_north_2');
    const journeyOutcome = async () => {
      const intent = (await db.doc(`brands/${B}/conversations/${conversationId}`).get()).get('current_intent_id');
      return (await db.collection(`brands/${B}/outcomes`).where('source_intent_id', '==', intent).get()).docs.map((d) =>
        d.data(),
      );
    };
    advanceMinutes(121);
    const first = await as('b').post('/api/brand/follow-ups/process-due');
    expect(first.body.reservations_expired).toBeGreaterThanOrEqual(1);
    expect((await lastUpdate(B, conversationId)).text).toBe(
      'Your hold at Andheri Store for Vitamin C Glow Serum 30 ml has expired.',
    );
    // Not at the moment the hold expires: the 30-min window counts from when the hold ended.
    expect(await journeyOutcome()).toEqual([]);
    advanceMinutes(20);
    await as('b').post('/api/brand/follow-ups/process-due');
    expect(await journeyOutcome()).toEqual([]);
    advanceMinutes(11);
    await as('b').post('/api/brand/follow-ups/process-due');
    expect(await journeyOutcome()).toEqual([
      expect.objectContaining({ purchase_type: 'NONE', evidence: 'WINDOW_CLOSED' }),
    ]);
  }, 60_000);

  it('7 · handoff → the Brand Admin replies as a person → resolve → the next message gets an automated reply', async () => {
    const tara = customer('b', B, 'tara_m6');
    const handoff = await tara.say('I want to talk to a person');
    const conv = handoff.body.conversation_id;
    const reply = await as('b').post(`/api/brand/conversations/${conv}/replies`, {
      text: 'Hi, this is the team. How can I help?',
    });
    expect(reply.body).toMatchObject({ origin: 'HUMAN_AGENT' });
    expect((await tara.say('thanks')).body.outbound_messages).toEqual([]);
    expect((await as('a').post(`/api/brand/conversations/${conv}/replies`, { text: 'x' })).status).toBe(404);
    await as('b').post(`/api/brand/conversations/${conv}/resolve`);
    const back = await tara.say('Is it good for oily skin?');
    expect(back.body.outbound_messages).toHaveLength(1);
    expect(back.body.decision.decision_source).toBe('AGENT');
    const audit = await db
      .collection(`brands/${B}/auditEvents`)
      .where('action', 'in', ['HUMAN_REPLY_SENT', 'HUMAN_HANDOFF_RESOLVED'])
      .get();
    expect(audit.size).toBe(2);
  }, 60_000);

  it('8 · the Outcomes screen totals match the stored records, with demo history included and excluded', async () => {
    const written = await container.demoReset.writeHistory(A);
    expect(written.outcomes).toBeGreaterThan(20);
    const nowIso = new Date(clock.t).toISOString();
    const fromIso = new Date(clock.t - 28 * 24 * 60 * 60_000).toISOString();
    const stored = (await db.collection(`brands/${A}/outcomes`).get()).docs
      .map((d) => d.data())
      .filter((o) => o.timestamp >= fromIso && o.timestamp <= nowIso);
    const count = (rows: FirebaseFirestore.DocumentData[]) =>
      Object.fromEntries(
        ['ONLINE', 'OFFLINE', 'ALTERNATIVE', 'NONE'].map((t) => [t, rows.filter((o) => o.purchase_type === t).length]),
      );

    const all = await as('a').get('/api/brand/insights?days=28&include_history=true');
    expect(all.body.funnel.outcomes).toEqual(count(stored));
    expect(all.body.demo_history.records).toBeGreaterThan(0);
    const live = await as('a').get('/api/brand/insights?days=28&include_history=false');
    expect(live.body.funnel.outcomes).toEqual(count(stored.filter((o) => o.demo_history !== true)));
    expect(live.body.funnel.outcomes.OFFLINE).toBe(1); // scenario 1's completed pickup, never flagged
    expect(all.body.weekday.reading).toMatchObject({ kind: 'AVAILABILITY_PROBLEM', peak_weekday: 'saturday' });
    expect(all.body.suggestions.map((s: { rule: string }) => s.rule)).toContain('STOCK_UNMET_AREA');

    // Every synthetic document is flagged; live ones never are.
    const reservations = (await db.collection(`brands/${A}/reservations`).get()).docs;
    const flagged = reservations.filter((d) => d.get('demo_history') === true).length;
    expect(flagged).toBe(written.reservations);
    expect(
      reservations
        .filter((d) => d.get('demo_history') !== true)
        .every((d) => !String(d.get('customer_id')).startsWith('hist')),
    ).toBe(true);
    // Another brand never sees it.
    expect((await as('b').get('/api/brand/insights?days=28')).body.demo_history.records).toBe(0);
  }, 90_000);
});
