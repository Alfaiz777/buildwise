/**
 * M4 local end-to-end on the Firebase Auth + Firestore emulators with the REAL composition
 * root (local profile): storefront event → intent → follow-up eligibility → due → brand's
 * message (simulator) → customer reply → ConversationPipeline → handoff / STOP.
 *
 * The container gets an injected clock so real due_at values are asserted without waiting.
 * Scenarios for the same shopper advance the clock by 25 h first, so the per-customer
 * 24-hour frequency limit does not interfere between them.
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
const SERUM_30 = 'gid://shopify/ProductVariant/2001';
const ASHA = 'gid://shopify/Customer/3002'; // opted in
const RAVI = 'gid://shopify/Customer/3003'; // not opted in

const clock = { t: Date.parse('2026-10-05T04:30:00.000Z') };
const advanceMinutes = (m: number) => (clock.t += m * 60_000);
const nextDay = () => advanceMinutes(25 * 60);

let app: ReturnType<typeof createApp>;
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

const FOLLOW_UP_POLICY = {
  inactivity_minutes: 1,
  frequency_hours: 24,
  types: {
    PRODUCT_CONSIDERATION: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
    CART_ABANDONMENT: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
    CHECKOUT_ABANDONMENT: { enabled: true, delay_minutes: 1, priority: 'HIGH' },
    STORE_ORIENTED: { enabled: true, delay_minutes: 1, priority: 'NORMAL' },
  },
};

async function seedBrand(brandId: string, name: string, adminEmail: string, key: string) {
  const { uid } = await auth.createUser({ email: adminEmail, password: PASSWORD });
  await db.doc(`brands/${brandId}`).set({
    brand_id: brandId,
    name,
    status: 'ACTIVE',
    brand_admin_user_id: uid,
    settings: {
      allowed_storefront_origins: [ORIGIN],
      human_handoff_rules: { enabled: true },
      messaging: { display_name: name, whatsapp_number: '910000000009' },
      follow_up_policy: FOLLOW_UP_POLICY,
    },
  });
  await db.doc(`users/${uid}`).set({
    user_id: uid,
    role: 'BRAND_ADMIN',
    brand_id: brandId,
    retailer_id: null,
    store_id: null,
    email: adminEmail,
    status: 'ACTIVE',
  });
  tokens[key] = await signIn(adminEmail);
  const sync = await request(app).post('/api/integrations/shopify/sync').set('Authorization', `Bearer ${tokens[key]}`);
  expect(sync.status).toBe(200);
}

const as = (key: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${tokens[key]}`),
  post: (path: string, body: object = {}) =>
    request(app).post(path).set('Authorization', `Bearer ${tokens[key]}`).send(body),
});

/** A storefront "tab": its own web session; `visitor` is kept across sessions. */
const storefront = (brandId: string, name: string, visitor = `vis_${name}_0000000`) => {
  const ids = { web_session_id: `ws_${name}_00000000`, visitor_id: visitor };
  return {
    ids,
    event: (event_type: string, extra: Record<string, unknown> = {}) =>
      request(app)
        .post('/api/intents')
        .set('Origin', ORIGIN)
        .send({ brand_id: brandId, client_event_id: `ce_${++n}`, event_type, ...ids, ...extra }),
    signInShopper: (shopperId: string) =>
      request(app)
        .post('/api/demo-storefront/shopper-sign-in')
        .set('Origin', ORIGIN)
        .send({ brand_id: brandId, shopper_id: shopperId, ...ids }),
    order: () =>
      request(app)
        .post('/api/demo-storefront/orders')
        .set('Origin', ORIGIN)
        .send({ brand_id: brandId, web_session_id: ids.web_session_id, shopify_variant_id: SERUM_30 }),
  };
};

const say = (key: string, ref: string, text: string) =>
  as(key).post('/api/channels/simulator/messages', {
    simulator_customer_ref: ref,
    client_message_id: `cm_${++n}`,
    content: { type: 'TEXT', text },
  });

const processDue = (key = 'brandAdmin') => as(key).post('/api/brand/follow-ups/process-due');

async function intentOf(brandId: string, webSessionId: string) {
  const snap = await db
    .collection(`brands/${brandId}/customerIntents`)
    .where('web_session_id', '==', webSessionId)
    .get();
  return snap.docs[0]!.data();
}

async function proactiveMessages(brandId: string) {
  const conversations = await db.collection(`brands/${brandId}/conversations`).get();
  const all = await Promise.all(conversations.docs.map((c) => c.ref.collection('messages').get()));
  return all
    .flatMap((s) => s.docs.map((d) => d.data()))
    .filter((m) => m.origin === 'PROACTIVE_FOLLOW_UP')
    .sort((a, b) => String(a.message_id).localeCompare(String(b.message_id)));
}

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'buildwise-m4-'));
  const config = loadConfig({
    ...process.env,
    BUILDWISE_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
  });
  app = createApp(buildContainer(config, silentLogger, { now: () => new Date(clock.t) }).appDeps);
  ({ auth, db } = initFirebase(PROJECT, config.emulators));
  await seedBrand('brd_m4', 'Demo Beauty Co', 'admin@m4.test', 'brandAdmin');
  await seedBrand('brd_m4b', 'Other Beauty Ltd', 'admin@m4b.test', 'otherAdmin');
}, 60_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('M4 local E2E: intent → follow-up → conversation', () => {
  it('1. anonymous product exploration: intent recorded, NOT_ELIGIBLE, nothing sent now or after the delay', async () => {
    const tab = storefront('brd_m4', 'anon');
    await tab.event('STOREFRONT_VISIT');
    await tab.event('PRODUCT_VIEW', { shopify_variant_id: SERUM_30 });
    await tab.event('PRODUCT_DETAIL_VIEW', { shopify_variant_id: SERUM_30 });
    const intent = await intentOf('brd_m4', tab.ids.web_session_id);
    expect(intent).toMatchObject({
      customer_id: null,
      intent_type: 'PRODUCT_EXPLORATION',
      intent_stage: 'PRODUCT_VIEW',
      follow_up: { status: 'NOT_ELIGIBLE', reason: 'WEAK_INTENT' },
    });
    advanceMinutes(10);
    expect((await processDue()).body.sent).toBe(0);
    expect((await intentOf('brd_m4', tab.ids.web_session_id)).status).toBe('ABANDONED');
    expect(await proactiveMessages('brd_m4')).toEqual([]);

    // The console shows it with only an opaque session reference.
    const list = await as('brandAdmin').get('/api/brand/intents');
    const row = list.body.intents.find((i: { anonymous: boolean }) => i.anonymous);
    expect(row.who).toMatch(/^visitor /);
    expect(JSON.stringify(list.body)).not.toContain(tab.ids.web_session_id);
  });

  it('9. a shopper without marketing consent abandons a cart → NOT_ELIGIBLE (NO_CONSENT)', async () => {
    const tab = storefront('brd_m4', 'ravi');
    expect((await tab.signInShopper(RAVI)).body.marketing_consent).toBe('NOT_OPTED_IN');
    await tab.event('ADD_TO_CART', { shopify_variant_id: SERUM_30 });
    expect((await intentOf('brd_m4', tab.ids.web_session_id)).follow_up).toMatchObject({
      status: 'NOT_ELIGIBLE',
      reason: 'NO_CONSENT',
    });
  });

  it('2 + 5. opted-in cart abandonment: nothing before due_at, then the brand’s personalised message; the reply runs the pipeline', async () => {
    nextDay();
    const tab = storefront('brd_m4', 'cart');
    await tab.signInShopper(ASHA);
    await tab.event('PRODUCT_DETAIL_VIEW', { shopify_variant_id: SERUM_30 });
    await tab.event('ADD_TO_CART', { shopify_variant_id: SERUM_30 });
    const scheduled = await intentOf('brd_m4', tab.ids.web_session_id);
    expect(scheduled.follow_up).toMatchObject({ status: 'SCHEDULED', priority: 'NORMAL' });
    expect(Date.parse(scheduled.follow_up.due_at) - clock.t).toBe(2 * 60_000);

    advanceMinutes(1);
    expect((await processDue()).body.sent).toBe(0); // not before due_at
    advanceMinutes(1);
    expect((await processDue()).body.sent).toBe(1);
    expect((await processDue()).body.sent).toBe(0); // never twice

    const [message] = await proactiveMessages('brd_m4');
    expect(message).toMatchObject({ message_kind: 'TEMPLATE', template_name: 'buildwise_cart_reminder_v1' });
    expect(message!.text).toContain('Hi, this is Demo Beauty Co.');
    expect(message!.text).toContain('Vitamin C Glow Serum (30 ml)');
    expect(message!.text).toContain('Reply STOP to opt out.');

    const reply = await say('brandAdmin', 'shopper_3002', 'Is it good for oily skin?');
    expect(reply.body.outbound_messages[0].text).toContain('Vitamin C Glow Serum');
    expect(reply.body.decision).toMatchObject({ runtime: 'MOCK', decision_source: 'AGENT' });
    expect((await intentOf('brd_m4', tab.ids.web_session_id)).follow_up.status).toBe('REPLIED');

    const detail = await as('brandAdmin').get(`/api/brand/conversations/${reply.body.conversation_id}`);
    expect(detail.body.messages.map((m: { origin: string }) => m.origin)).toEqual([
      'PROACTIVE_FOLLOW_UP',
      'CUSTOMER',
      'AUTOMATED_REPLY',
    ]);
    expect(detail.body.web_events.map((e: { event_type: string }) => e.event_type)).toEqual(
      expect.arrayContaining(['PRODUCT_DETAIL_VIEW', 'ADD_TO_CART', 'FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_SENT']),
    );
  });

  it('3. checkout abandonment: HIGH priority, shorter delay, personalised message', async () => {
    nextDay();
    const tab = storefront('brd_m4', 'checkout');
    await tab.signInShopper(ASHA);
    await tab.event('CHECKOUT_STARTED', { shopify_variant_id: SERUM_30 });
    const intent = await intentOf('brd_m4', tab.ids.web_session_id);
    expect(intent.follow_up).toMatchObject({ status: 'SCHEDULED', priority: 'HIGH' });
    expect(Date.parse(intent.follow_up.due_at) - clock.t).toBe(60_000);
    advanceMinutes(1);
    expect((await processDue()).body.sent).toBe(1);
    const messages = await proactiveMessages('brd_m4');
    // The customer messaged within 24 h (scenario 5 was the day before), so this one is outside → TEMPLATE.
    expect(messages.at(-1)!.text).toContain('checking out with Vitamin C Glow Serum');
  });

  it('8. an order before due_at suppresses the abandonment follow-up (ALREADY_CONVERTED)', async () => {
    nextDay();
    const tab = storefront('brd_m4', 'order');
    await tab.signInShopper(ASHA);
    await tab.event('ADD_TO_CART', { shopify_variant_id: SERUM_30 });
    expect((await tab.order()).body).toMatchObject({ order_recorded: true, intent_converted: true, attributed: false });
    const intent = await intentOf('brd_m4', tab.ids.web_session_id);
    expect(intent).toMatchObject({
      status: 'CONVERTED',
      follow_up: { status: 'SUPPRESSED', reason: 'ALREADY_CONVERTED' },
    });
    const before = (await proactiveMessages('brd_m4')).length;
    advanceMinutes(5);
    await processDue();
    expect(await proactiveMessages('brd_m4')).toHaveLength(before);
  });

  it('4. "Need it today?" without sending → store-oriented follow-up; sending the prefilled text instead → bound, no follow-up', async () => {
    nextDay();
    const left = storefront('brd_m4', 'storeleft');
    await left.signInShopper(ASHA);
    await left.event('WHATSAPP_CLICK', { entry: 'STORE_NEED', shopify_variant_id: SERUM_30 });
    advanceMinutes(1);
    expect((await processDue()).body.sent).toBe(1);
    expect((await proactiveMessages('brd_m4')).at(-1)!.text).toContain(
      'Looking for Vitamin C Glow Serum (30 ml) today?',
    );

    nextDay();
    const chatted = storefront('brd_m4', 'storechat');
    await chatted.signInShopper(ASHA);
    const click = await chatted.event('WHATSAPP_CLICK', { entry: 'STORE_NEED', shopify_variant_id: SERUM_30 });
    const prefilled: string = click.body.whatsapp.prefilled_text;
    const res = await say('brandAdmin', 'shopper_3002', `${prefilled} Do you have it in Bandra?`);
    expect(res.status).toBe(200);
    const intent = await intentOf('brd_m4', chatted.ids.web_session_id);
    expect(intent.token_consumed_at).toBeTruthy();
    expect(intent.follow_up).toMatchObject({ status: 'NOT_ELIGIBLE', reason: 'CUSTOMER_ALREADY_IN_CONVERSATION' });
    const before = (await proactiveMessages('brd_m4')).length;
    advanceMinutes(5);
    await processDue();
    expect(await proactiveMessages('brd_m4')).toHaveLength(before);

    // 10. The token never reaches stored text; reusing it elsewhere binds nothing.
    const conversation = await as('brandAdmin').get(`/api/brand/conversations/${res.body.conversation_id}`);
    const token = prefilled.replace('START_BUILDWISE_', '');
    expect(JSON.stringify(conversation.body)).not.toContain(token);
    const reuse = await say('brandAdmin', 'intruder_01', prefilled);
    expect(reuse.status).toBe(200);
    const intruderConversation = await as('brandAdmin').get(`/api/brand/conversations/${reuse.body.conversation_id}`);
    expect(intruderConversation.body.intent).toBeNull();
    const tokenSnap = await db.collection('intentTokens').where('intent_id', '==', intent.intent_id).get();
    expect(tokenSnap.docs[0]!.id).not.toContain(token); // only the hash is stored

    // Another brand cannot read this brand's conversation or intents.
    expect((await as('otherAdmin').get(`/api/brand/conversations/${res.body.conversation_id}`)).status).toBe(404);
    expect((await as('otherAdmin').get('/api/brand/intents')).body.intents).toEqual([]);
  });

  it('6. STOP → OPTED_OUT, and a follow-up that was scheduled is SUPPRESSED at send time', async () => {
    nextDay();
    const tab = storefront('brd_m4', 'stop');
    await tab.signInShopper(ASHA);
    await tab.event('ADD_TO_CART', { shopify_variant_id: SERUM_30 });
    expect((await intentOf('brd_m4', tab.ids.web_session_id)).follow_up.status).toBe('SCHEDULED');
    const stop = await say('brandAdmin', 'shopper_3002', 'STOP');
    expect(stop.body.outbound_messages).toEqual([]);
    advanceMinutes(3);
    const due = await processDue();
    expect(due.body.suppressed).toBeGreaterThanOrEqual(1);
    expect((await intentOf('brd_m4', tab.ids.web_session_id)).follow_up).toMatchObject({
      status: 'SUPPRESSED',
      reason: 'OPTED_OUT',
    });
  });

  it('7. after a follow-up, asking for a person → HANDOFF; automation stops (separate brand)', async () => {
    const tab = storefront('brd_m4b', 'handoff');
    await tab.signInShopper(ASHA);
    await tab.event('ADD_TO_CART', { shopify_variant_id: SERUM_30 });
    advanceMinutes(3);
    expect((await processDue('otherAdmin')).body.sent).toBe(1);
    const handoff = await say('otherAdmin', 'shopper_3002', 'I want to talk to a person');
    expect(handoff.body.decision.action).toBe('HUMAN_HANDOFF');
    expect((await intentOf('brd_m4b', tab.ids.web_session_id)).follow_up.status).toBe('HANDOFF');
    const list = await as('otherAdmin').get('/api/brand/conversations');
    expect(list.body.conversations[0]).toMatchObject({ human_handoff: true });
    const after = await say('otherAdmin', 'shopper_3002', 'hello?');
    expect(after.body.outbound_messages).toEqual([]);
  });
});
