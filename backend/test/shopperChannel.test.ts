/**
 * Change 16 (UI-2): the shopper demo channel. The browser never chooses a customer ref
 * (the server signs it into a session token), and the channel exists only where it may:
 * local always; gcp only with DEMO_MODE on, for the allowlisted demo brands only.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';
import { buildScenarioWorld } from './scenarioWorld.js';

type World = ReturnType<typeof buildTestWorld>;
const HEADER = 'X-Qwikspot-Shopper-Session';
let n = 0;

async function synced(options: Parameters<typeof buildTestWorld>[0] = {}) {
  const world = buildTestWorld(options);
  await world.commerceSync.sync('brand_A', { type: 'SYSTEM', id: 'test' });
  return world;
}
const start = (world: World, body: object = { brand_id: 'brand_A' }, origin = TEST_ORIGIN) =>
  request(world.app).post('/api/shopper/session').set('Origin', origin).send(body);
const send = (world: World, token: string, content: object, extra: object = {}) =>
  request(world.app)
    .post('/api/shopper/messages')
    .set('Origin', TEST_ORIGIN)
    .set(HEADER, token)
    .send({ client_message_id: `cm_shop_${String(++n).padStart(4, '0')}`, content, ...extra });
const poll = (world: World, token: string, after?: string) =>
  request(world.app)
    .get(`/api/shopper/messages${after ? `?after=${after}` : ''}`)
    .set(HEADER, token);

const DEMO = { enabled: true, brandIds: ['brand_A'], holdMinutes: 20, logins: [] };

describe('shopper session identity', () => {
  it('a guest session gets a server-made judge_ ref; the token carries no personal data', async () => {
    const world = await synced();
    const res = await start(world);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ session_token: expect.any(String), brand: { brand_id: 'brand_A' } });
    const payload = JSON.parse(Buffer.from(res.body.session_token.split('.')[0], 'base64url').toString());
    expect(payload.r).toMatch(/^judge_[a-z2-9]{8}$/);
    expect(Object.keys(payload).sort()).toEqual(['b', 'exp', 'iat', 'r', 'v']);
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'SHOPPER_SESSION_STARTED', reasonCode: 'GUEST' });
  });

  it('a demo shopper is chosen by shopper id, mapped server-side; unknown shoppers are refused', async () => {
    const world = await synced();
    const ok = await start(world, { brand_id: 'brand_A', shopper_id: 'gid://shopify/Customer/3002' });
    const payload = JSON.parse(Buffer.from(ok.body.session_token.split('.')[0], 'base64url').toString());
    expect(payload.r).toBe('shopper_3002');
    expect((await start(world, { brand_id: 'brand_A', shopper_id: 'gid://shopify/Customer/9999' })).status).toBe(404);
  });

  it('the browser cannot name a customer ref: extra fields are refused', async () => {
    const world = await synced();
    expect((await start(world, { brand_id: 'brand_A', customer_ref: 'shopper_3002' })).status).toBe(400);
    const token = (await start(world)).body.session_token;
    for (const extra of [{ simulator_customer_ref: 'shopper_3002' }, { customer_ref: 'x' }, { brand_id: 'brand_B' }]) {
      expect((await send(world, token, { type: 'TEXT', text: 'hi' }, extra)).status).toBe(400);
    }
  });

  it('no, tampered, expired or other-brand tokens are 401', async () => {
    const clock = { t: Date.parse('2026-10-07T06:30:00.000Z') };
    const world = await synced({ now: () => new Date(clock.t) });
    const token = (await start(world)).body.session_token as string;
    expect((await request(world.app).post('/api/shopper/messages').set('Origin', TEST_ORIGIN).send({})).status).toBe(
      401,
    );
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), r: 'shopper_3002' }),
    ).toString('base64url');
    expect((await poll(world, `${forged}.${sig}`)).status).toBe(401);
    expect((await poll(world, `${payload}.${sig!.slice(0, -2)}xx`)).status).toBe(401);
    clock.t += 13 * 60 * 60 * 1000;
    const expired = await poll(world, token);
    expect([expired.status, expired.body.error.code]).toEqual([401, 'SHOPPER_SESSION_INVALID']);
  });

  it('a non-allowlisted storefront origin cannot start a session or send', async () => {
    const world = await synced();
    expect((await start(world, { brand_id: 'brand_A' }, 'https://evil.example')).status).toBe(403);
  });
});

describe('shopper conversation', () => {
  it('runs the same pipeline; polling returns only this session’s messages, without internal labels', async () => {
    const world = await synced();
    const a = (await start(world)).body.session_token as string;
    const b = (await start(world)).body.session_token as string;
    const sent = await send(world, a, { type: 'TEXT', text: 'Is the vitamin C serum good for oily skin?' });
    expect(sent.status).toBe(200);
    expect(sent.body.messages.length).toBeGreaterThan(0);
    const mine = await poll(world, a);
    expect(mine.body.messages.map((m: { from: string }) => m.from)).toEqual(['SHOPPER', 'BRAND']);
    expect(mine.body.messages[1]).not.toHaveProperty('origin');
    expect(mine.body.messages[1]).not.toHaveProperty('template_name');
    expect((await poll(world, b)).body).toEqual({ conversation_id: null, messages: [] });
    const after = await poll(world, a, mine.body.messages[0].message_id);
    expect(after.body.messages).toHaveLength(1);
    expect((await poll(world, a, 'not-an-id')).status).toBe(400);
  });

  it('a hold from the shopper reaches the store; the store update appears in the shopper’s poll', async () => {
    const { world } = await buildScenarioWorld();
    const token = (await start(world)).body.session_token as string;
    const click = await request(world.app).post('/api/intents').set('Origin', TEST_ORIGIN).send({
      brand_id: 'brand_A',
      web_session_id: 'ws_shopper_00000001',
      visitor_id: 'vis_shopper_0000001',
      client_event_id: 'ce_shopper_1',
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
    });
    await send(world, token, { type: 'TEXT', text: `${click.body.whatsapp.prefilled_text} I need it today` });
    await send(world, token, { type: 'LOCATION', latitude: 19.0, longitude: 72.8 });
    const offer = (await poll(world, token)).body.messages.at(-1);
    expect(offer.parts.header).toMatchObject({ type: 'IMAGE' });
    expect(offer.parts.footer).toBe('Powered by Qwikspot');
    await send(world, token, { type: 'INTERACTIVE_REPLY', option_id: 'hold:sc_A' });
    const reservation = world.reservations.reservations[0]!;
    expect(reservation.storeId).toBe('sc_A');
    const before = (await poll(world, token)).body.messages.at(-1).message_id;
    await request(world.app)
      .patch(`/api/reservations/${reservation.reservationId}`)
      .set('Authorization', bearer('radmin_scA'))
      .send({ status: 'CONFIRMED', expected_current_status: 'PENDING' });
    const update = (await poll(world, token, before)).body.messages;
    expect(update).toHaveLength(1);
    expect(update[0].text).toContain('confirmed your hold');
  });

  it('rate limits: 20 messages per session per minute', async () => {
    const world = await synced();
    const token = (await start(world)).body.session_token as string;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await send(world, token, { type: 'TEXT', text: 'hello' })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('where the shopper demo exists (docs/07 §19, Change 16)', () => {
  it('gcp with DEMO_MODE off: /api/shopper and /api/demo-storefront are not mounted', async () => {
    const world = await synced({ profile: 'gcp', demoStorefront: false });
    expect((await start(world)).status).toBe(401); // unknown /api route, signed out
    expect((await request(world.app).get('/api/demo-storefront/products?brand_id=brand_A')).status).toBe(401);
  });

  it('gcp with DEMO_MODE on: the allowlisted demo brand works; any other brand is 404', async () => {
    const world = await synced({ profile: 'gcp', demo: DEMO });
    expect((await start(world)).status).toBe(201);
    expect((await start(world, { brand_id: 'brand_B' })).status).toBe(404);
    expect((await request(world.app).get('/api/demo-storefront/products?brand_id=brand_A')).status).toBe(200);
    expect((await request(world.app).get('/api/demo-storefront/products?brand_id=brand_B')).status).toBe(404);
  });

  it('/api/demo/config names the shopper demo brand', async () => {
    const world = await synced({ profile: 'gcp', demo: DEMO });
    expect((await request(world.app).get('/api/demo/config')).body).toMatchObject({
      demo_mode: true,
      shopper_demo: { brand_id: 'brand_A' },
    });
  });
});
