/**
 * M7 — the whole product journey on the Firebase Auth + Firestore emulators with the REAL
 * composition root (local profile, MockAgentRuntime), driven only through the HTTP API.
 *
 * Bootstrap writes (the only two outside the product, as in L3):
 * - the Platform Admin (what `seed:platform-admin` does);
 * - the new brand's settings — there is no settings screen yet; `seed:demo` / `seed:live`
 *   write the same document.
 * Everything else — brand, Brand Admin, catalog, stores, retailers, Retail Admins, the
 * storefront intent, the conversation, the reservation, its fulfilment, the online order and
 * the insights — goes through the API, while every log line is captured for the PII check.
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
import { createLogger } from '../../src/lib/logger.js';

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
const NEAR_POWAI = { latitude: 19.12, longitude: 72.9 };
const NEAR_BANDRA = { latitude: 19.06, longitude: 72.83 };
const clock = { t: Date.parse('2026-10-07T06:30:00.000Z') }; // Wednesday 12:00 in Mumbai

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof initFirebase>['db'];
let auth: ReturnType<typeof initFirebase>['auth'];
let dataDir = '';
const logLines: string[] = [];
const tokens: Record<string, string> = {};
let brandId = '';
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

/** Stands in for the person opening their password-setup link. */
async function completeSetup(email: string): Promise<string> {
  const { uid } = await auth.getUserByEmail(email);
  await auth.updateUser(uid, { password: PASSWORD });
  return signIn(email);
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

const customer = (ref: string) => {
  const send = (content: object) =>
    as('brand').post('/api/channels/simulator/messages', {
      simulator_customer_ref: ref,
      client_message_id: `cm_${++n}`,
      content,
    });
  return {
    say: (text: string) => send({ type: 'TEXT', text }),
    share: (p: { latitude: number; longitude: number }) => send({ type: 'LOCATION', ...p }),
    tap: (optionId: string) => send({ type: 'INTERACTIVE_REPLY', option_id: optionId }),
    /** Taps "Need it today?" on the storefront, then sends the prefilled WhatsApp text. */
    fromStore: async (text: string) => {
      const click = await request(app)
        .post('/api/intents')
        .set('Origin', ORIGIN)
        .send({
          brand_id: brandId,
          web_session_id: `ws_${ref}_${++n}_000000`,
          visitor_id: `vis_${ref}_0000000`,
          client_event_id: `ce_${++n}`,
          event_type: 'WHATSAPP_CLICK',
          entry: 'STORE_NEED',
          shopify_variant_id: 'gid://shopify/ProductVariant/2001',
        });
      return send({ type: 'TEXT', text: `${click.body.whatsapp.prefilled_text} ${text}` });
    },
  };
};

const move = (key: string, id: string, status: string, from: string, extra: object = {}) =>
  as(key).patch(`/api/reservations/${id}`, { status, expected_current_status: from, ...extra });

const optionIds = (res: request.Response) =>
  (res.body.outbound_messages[0].options ?? []).map((o: { option_id: string }) => o.option_id) as string[];

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'buildwise-m7-'));
  const config = loadConfig({
    ...process.env,
    BUILDWISE_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
  });
  const logger = createLogger('debug', (line) => logLines.push(line));
  app = createApp(buildContainer(config, logger, { now: () => new Date(clock.t) }).appDeps);
  ({ auth, db } = initFirebase(PROJECT, config.emulators));

  const platform = await auth.createUser({ email: 'platform@journey.test', password: PASSWORD });
  await db.doc(`users/${platform.uid}`).set({
    user_id: platform.uid,
    role: 'PLATFORM_ADMIN',
    brand_id: null,
    retailer_id: null,
    store_id: null,
    email: 'platform@journey.test',
    status: 'ACTIVE',
  });
  tokens.platform = await signIn('platform@journey.test');
}, 60_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('M7 full journey — platform → brand → stores → customer → store → outcome → insights', () => {
  let andheriHold = { id: '', pickupCode: '', conversationId: '', recommendationId: '' };

  it('1 · the Platform Admin creates a brand and provisions its Brand Admin, who signs in', async () => {
    const created = await as('platform').post('/api/platform/brands', { name: 'Journey Beauty' });
    expect(created.status).toBe(201);
    brandId = created.body.brand_id;
    const admin = await as('platform').post(`/api/platform/brands/${brandId}/admins`, {
      email: 'admin@journey-brand.test',
    });
    expect(admin.body.password_setup_link).toMatch(/^http/);
    tokens.brand = await completeSetup('admin@journey-brand.test');
    expect((await as('brand').get('/api/me')).body).toMatchObject({ role: 'BRAND_ADMIN', brand_id: brandId });

    // Bootstrap: the brand's settings (no settings screen yet — see the header).
    await db.doc(`brands/${brandId}`).update({
      settings: {
        allowed_storefront_origins: [ORIGIN],
        human_handoff_rules: { enabled: true },
        messaging: { display_name: 'Journey Beauty', whatsapp_number: '910000000007' },
        reservation_policy: { reservations_enabled: true, hold_minutes: 120, max_quantity_per_reservation: 2 },
        online_store: { product_url_template: 'http://localhost:5173/demo-store#product={product_id}' },
        outcome_policy: { attribution_window_minutes: 30 },
      },
    });
  });

  it('2 · sync → retailers → retail import with a row report → mapping health → Retail Admins provisioned', async () => {
    const sync = await as('brand').post('/api/integrations/shopify/sync');
    expect(sync.body.status).toBe('CONNECTED');

    const north = (await as('brand').post('/api/brand/retailers', { name: 'North Retail' })).body.retailer_id;
    const pune = (await as('brand').post('/api/brand/retailers', { name: 'Pune Retail' })).body.retailer_id;
    expect(north).toBeTruthy();
    const csv = (await readFile(new URL('../../fixtures/retail/demo-retail.csv', import.meta.url), 'utf8'))
      .replaceAll(',rtl_north,', `,${north},`)
      .replaceAll(',rtl_pune,', `,${pune},`);
    const created = await as('brand').post('/api/brand/retail-imports', { file_name: 'journey-retail.csv' });
    expect((await as('brand').put(created.body.upload.url, Buffer.from(csv))).status).toBe(200);
    const report = await as('brand').post(`/api/brand/retail-imports/${created.body.import.import_id}/process`);
    expect(report.body.status).toBe('COMPLETED');
    expect(report.body.rows_valid).toBeGreaterThan(0);

    const products = await as('brand').get('/api/products');
    expect(products.body.mapping_summary.auto_matched).toBeGreaterThan(0);
    const stores = (await as('brand').get('/api/brand/stores')).body.stores;
    expect(stores.find((s: { store_id: string }) => s.store_id === 'st_north_2').retailer_id).toBe(north);

    for (const [storeId, email, key] of [
      ['st_north_2', 'andheri@journey.test', 'andheri'],
      ['st_north_1', 'bandra@journey.test', 'bandra'],
    ] as const) {
      const res = await as('brand').post(`/api/brand/stores/${storeId}/admins`, { email });
      expect(res.status).toBe(201);
      tokens[key] = await completeSetup(email);
      expect((await as(key).get('/api/me')).body).toMatchObject({ role: 'RETAIL_ADMIN', store_id: storeId });
    }
  }, 60_000);

  it('3 · storefront intent → an invalid token is silently ignored (audited) → the real token binds → store recommendation → reserve', async () => {
    const asha = customer('asha_journey');
    const forged = await asha.say('START_BUILDWISE_0123456789ABCDEFGHJKMNPQRS hi');
    expect(forged.status).toBe(200);
    expect(JSON.stringify(forged.body.outbound_messages)).not.toMatch(/invalid|token/i); // no oracle
    const rejected = await db
      .collection(`brands/${brandId}/auditEvents`)
      .where('action', '==', 'INTENT_TOKEN_REJECTED')
      .get();
    expect(rejected.size).toBe(1);

    const click = await request(app).post('/api/intents').set('Origin', ORIGIN).send({
      brand_id: brandId,
      web_session_id: 'ws_journey_asha_0001',
      visitor_id: 'vis_journey_asha_01',
      client_event_id: 'ce_journey_1',
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
    });
    expect(click.status).toBe(202);
    const bound = await asha.say(`${click.body.whatsapp.prefilled_text} I need it today`);
    expect(bound.body.decision.action).toBe('STORE_DISCOVERY');
    expect(
      (await db.collection(`brands/${brandId}/auditEvents`).where('action', '==', 'INTENT_TOKEN_BOUND').get()).size,
    ).toBe(1);

    const offer = await asha.share(NEAR_POWAI);
    expect(optionIds(offer)).toContain('hold:st_north_2');
    const hold = await asha.tap('hold:st_north_2');
    expect(hold.body.decision).toMatchObject({
      guardrail_status: 'ALLOWED',
      executed_action: { type: 'RESERVATION_CREATED' },
    });
    const id = hold.body.decision.executed_action.reservation_id as string;
    const doc = (await db.doc(`brands/${brandId}/reservations/${id}`).get()).data()!;
    andheriHold = {
      id,
      pickupCode: doc.pickup_code,
      conversationId: hold.body.conversation_id,
      recommendationId: hold.body.decision.recommendation_id,
    };
    expect(doc).toMatchObject({ store_id: 'st_north_2', status: 'PENDING' });
  }, 60_000);

  it('4 · the Retail Admin confirms → ready → arrived → completes with the code → OFFLINE; the brand sees it in Outcomes and the trace', async () => {
    const { id, pickupCode, conversationId } = andheriHold;
    const queue = await as('andheri').get('/api/reservations?view=active');
    expect(queue.body.reservations.map((r: { reservation_id: string }) => r.reservation_id)).toEqual([id]);
    expect(JSON.stringify(queue.body)).not.toMatch(/asha|sim:|cus_/); // no customer identity at the store
    expect((await as('bandra').get('/api/reservations?view=active')).body.reservations).toEqual([]);

    expect((await move('andheri', id, 'CONFIRMED', 'PENDING')).body.notification.status).toBe('SENT');
    await move('andheri', id, 'READY', 'CONFIRMED');
    await move('andheri', id, 'CUSTOMER_ARRIVED', 'READY');
    const done = await move('andheri', id, 'COMPLETED', 'CUSTOMER_ARRIVED', { pickup_code: pickupCode });
    expect(done.body.status).toBe('COMPLETED');

    const insights = await as('brand').get('/api/brand/insights?days=28');
    expect(insights.body.funnel.outcomes.OFFLINE).toBe(1);
    const detail = await as('brand').get(`/api/brand/conversations/${conversationId}`);
    expect(detail.body.recommendations.at(-1)).toMatchObject({
      trace: { guardrail: { status: 'ALLOWED', checked: 'CREATE_RESERVATION' } },
      reservation: { store_id: 'st_north_2', status: 'COMPLETED' },
    });
  }, 60_000);

  it('5 · Buy online → bw_ref → demo storefront order → ONLINE outcome', async () => {
    const om = customer('om_journey');
    await om.fromStore('I need it today');
    await om.share(NEAR_POWAI);
    const online = await om.tap('buy_online');
    const ref = /bw_ref=([0-9A-Z]{26})/.exec(online.body.outbound_messages[0].text)![1];
    const order = await request(app).post('/api/demo-storefront/orders').set('Origin', ORIGIN).send({
      brand_id: brandId,
      web_session_id: 'ws_journey_om_00001',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
      bw_ref: ref,
    });
    expect(order.body).toMatchObject({ attributed: true, outcome_recorded: true });
    const insights = await as('brand').get('/api/brand/insights?days=28');
    expect(insights.body.funnel.outcomes).toMatchObject({ OFFLINE: 1, ONLINE: 1 });
  }, 60_000);

  it('6 · the store refuses → the customer gets an apology and a hold at the next store → a new reservation', async () => {
    const ravi = customer('ravi_journey');
    await ravi.fromStore('I need it today');
    const offer = await ravi.share(NEAR_BANDRA);
    expect(optionIds(offer)).toContain('hold:st_north_1');
    const hold = await ravi.tap('hold:st_north_1');
    const id = hold.body.decision.executed_action.reservation_id as string;
    const refused = await move('bandra', id, 'CANCELLED', 'PENDING', { cancel_reason: 'NOT_ACTUALLY_IN_STOCK' });
    expect(refused.body).toMatchObject({ cancelled_by: 'RETAILER', notification: { event: 'REFUSED' } });
    const messages = (await as('brand').get(`/api/brand/conversations/${hold.body.conversation_id}`)).body.messages as {
      text: string;
      options?: { option_id: string }[];
    }[];
    const apology = messages.at(-1)!;
    expect(apology.text).toMatch(/^Sorry — Bandra Store can't fulfil your reservation/);
    expect(apology.options!.map((o) => o.option_id)).toContain('hold:st_north_2');
    const again = await ravi.tap('hold:st_north_2');
    expect(again.body.decision.executed_action.type).toBe('RESERVATION_CREATED');
  }, 60_000);

  it('customer isolation: each conversation, trace and queue only ever shows its own customer', async () => {
    const list = (await as('brand').get('/api/brand/conversations')).body.conversations as {
      conversation_id: string;
    }[];
    expect(list.length).toBeGreaterThanOrEqual(3);
    const customerIds = new Set<string>();
    for (const c of list) {
      const detail = (await as('brand').get(`/api/brand/conversations/${c.conversation_id}`)).body;
      const own = (await db.doc(`brands/${brandId}/conversations/${c.conversation_id}`).get()).get('customer_id');
      customerIds.add(own);
      const reservations = (
        await db.collection(`brands/${brandId}/reservations`).where('conversation_id', '==', c.conversation_id).get()
      ).docs.map((d) => d.get('customer_id'));
      expect(reservations.every((r) => r === own)).toBe(true);
      // No other customer's ID appears in this conversation's messages or traces.
      const others = [...customerIds].filter((x) => x !== own);
      for (const other of others) expect(JSON.stringify(detail)).not.toContain(other);
    }
    expect(customerIds.size).toBe(list.length);
  });

  it('the whole journey logged no PII, tokens, pickup codes, bw_ref values or message text', () => {
    const log = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(30);
    expect(log).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(log).not.toMatch(/\+91|\b\d{10}\b/);
    expect(log).not.toMatch(/START_BUILDWISE_|bw_ref=/);
    expect(log).not.toMatch(new RegExp(`\\b${andheriHold.pickupCode}\\b`));
    expect(log).not.toMatch(/I need it today|Sorry — Bandra/);
  });
});
