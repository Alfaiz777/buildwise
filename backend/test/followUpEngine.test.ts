import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';

/**
 * The follow-up engine over HTTP, with an injected clock: real due_at values are asserted
 * without sleeping, and nothing is ever sent before due_at.
 */

const SERUM_30 = 'gid://shopify/ProductVariant/2001';
const OPTED_IN = 'gid://shopify/Customer/3002';
const NOT_OPTED_IN = 'gid://shopify/Customer/3003';

type World = ReturnType<typeof buildTestWorld>;
let n = 0;

async function setup() {
  const clock = { t: new Date('2026-10-05T10:00:00.000Z').getTime() };
  const world = buildTestWorld({ now: () => new Date(clock.t) });
  await world.commerceSync.sync('brand_A', { type: 'SYSTEM', id: 'test' });
  const advance = (minutes: number) => (clock.t += minutes * 60_000);
  return { world, clock, advance };
}

const session = (s: string) => ({ web_session_id: `ws_${s}_000000`, visitor_id: `vis_${s}_00000` });

const event = (world: World, s: string, body: Record<string, unknown>) =>
  request(world.app)
    .post('/api/intents')
    .set('Origin', TEST_ORIGIN)
    .send({ brand_id: 'brand_A', client_event_id: `ce_${++n}`, ...session(s), ...body });

const signIn = (world: World, s: string, shopperId: string) =>
  request(world.app)
    .post('/api/demo-storefront/shopper-sign-in')
    .set('Origin', TEST_ORIGIN)
    .send({ brand_id: 'brand_A', shopper_id: shopperId, ...session(s) });

const processDue = (world: World, user = 'admin_a') =>
  request(world.app).post('/api/brand/follow-ups/process-due').set('Authorization', bearer(user));

const simulate = (world: World, ref: string, text: string) =>
  request(world.app)
    .post('/api/channels/simulator/messages')
    .set('Authorization', bearer('admin_a'))
    .send({ simulator_customer_ref: ref, client_message_id: `cm_${++n}`, content: { type: 'TEXT', text } });

const intentOf = (world: World, s: string) => world.intents.intents.find((i) => i.webSessionId === `ws_${s}_000000`)!;
const proactive = (world: World) => world.conversations.messages.filter((m) => m.origin === 'PROACTIVE_FOLLOW_UP');

describe('follow-up engine (docs/00 §11.8 Change 11)', () => {
  it('anonymous visitors: intents recorded and classified, never messaged (WEAK_INTENT / CUSTOMER_NOT_REACHABLE)', async () => {
    const { world, advance } = await setup();
    await event(world, 'browse', { event_type: 'PRODUCT_VIEW', shopify_variant_id: SERUM_30 });
    await event(world, 'cart', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    expect(intentOf(world, 'browse').followUp).toMatchObject({ status: 'NOT_ELIGIBLE', reason: 'WEAK_INTENT' });
    expect(intentOf(world, 'cart').followUp).toMatchObject({
      status: 'NOT_ELIGIBLE',
      reason: 'CUSTOMER_NOT_REACHABLE',
    });
    advance(10);
    const res = await processDue(world);
    expect(res.body).toMatchObject({ abandoned: 2, sent: 0, suppressed: 0 });
    expect(proactive(world)).toEqual([]);
    expect(intentOf(world, 'cart').status).toBe('ABANDONED');
  });

  it('opted-in shopper, cart abandonment: nothing before due_at; after it, one personalised template message from the brand', async () => {
    const { world, advance } = await setup();
    const signedIn = await signIn(world, 'asha', OPTED_IN);
    expect(signedIn.body).toMatchObject({ marketing_consent: 'OPTED_IN', simulator_customer_ref: 'shopper_3002' });
    await event(world, 'asha', { event_type: 'PRODUCT_VIEW', shopify_variant_id: SERUM_30 });
    await event(world, 'asha', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });

    const intent = intentOf(world, 'asha');
    expect(intent).toMatchObject({ type: 'CART_ABANDONMENT', customerId: expect.stringMatching(/^cus_/) });
    expect(intent.followUp).toMatchObject({
      decision: 'FOLLOW_UP_ELIGIBLE',
      status: 'SCHEDULED',
      priority: 'NORMAL',
      dueAt: '2026-10-05T10:02:00.000Z',
    });
    expect(world.events.events.map((e) => e.eventType)).toContain('FOLLOW_UP_SCHEDULED');

    advance(1);
    expect((await processDue(world)).body).toMatchObject({ sent: 0 }); // abandoned, but not due yet
    expect(intentOf(world, 'asha').status).toBe('ABANDONED');
    advance(1);
    expect((await processDue(world)).body).toMatchObject({ sent: 1, suppressed: 0 });

    const [message] = proactive(world);
    expect(message).toMatchObject({
      messageKind: 'TEMPLATE',
      templateName: 'qwikspot_cart_reminder_v1',
      deliveryStatus: 'DELIVERED',
    });
    expect(message!.text).toContain('Hi, this is Brand brand_A.');
    expect(message!.text).toContain('Vitamin C Glow Serum (30 ml)');
    expect(message!.text).toContain('Reply STOP to opt out.');
    expect(message!.text).not.toMatch(/₹|795|stock/);
    expect(intentOf(world, 'asha').followUp).toMatchObject({ status: 'SENT', messageKind: 'TEMPLATE' });
    expect(world.conversations.conversations[0]).toMatchObject({ currentIntentId: intent.intentId });
    expect(world.customers.customers[0]!.lastProactiveAt).toBe('2026-10-05T10:02:00.000Z');
    expect(world.events.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['FOLLOW_UP_SENT', 'MESSAGE_SENT']),
    );

    // Idempotent: running again (or concurrently) never sends twice.
    const again = await Promise.all([processDue(world), processDue(world)]);
    expect(again.map((r) => r.body.sent)).toEqual([0, 0]);
    expect(proactive(world)).toHaveLength(1);
  });

  it('concurrent process-due runs on a due follow-up send it exactly once', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'race', OPTED_IN);
    await event(world, 'race', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    advance(3);
    const runs = await Promise.all([processDue(world), processDue(world), processDue(world)]);
    expect(runs.reduce((sum, r) => sum + r.body.sent, 0)).toBe(1);
    expect(proactive(world)).toHaveLength(1);
  });

  it('checkout abandonment: HIGH priority, shorter delay', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'checkout', OPTED_IN);
    await event(world, 'checkout', { event_type: 'CHECKOUT_STARTED', shopify_variant_id: SERUM_30 });
    expect(intentOf(world, 'checkout').followUp).toMatchObject({ priority: 'HIGH', dueAt: '2026-10-05T10:01:00.000Z' });
    advance(1);
    await processDue(world);
    expect(proactive(world)[0]!.text).toContain('checking out with Vitamin C Glow Serum');
  });

  it('the customer replies → normal pipeline, follow-up REPLIED, the agent reply stays on the product', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'reply', OPTED_IN);
    await event(world, 'reply', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    advance(3);
    await processDue(world);
    const reply = await simulate(world, 'shopper_3002', 'Is it good for oily skin?');
    expect(reply.body.outbound_messages[0]).toMatchObject({ origin: 'AUTOMATED_REPLY', message_kind: 'SESSION' });
    expect(reply.body.outbound_messages[0].text).toContain('Vitamin C Glow Serum');
    expect(intentOf(world, 'reply').followUp!.status).toBe('REPLIED');
    expect(world.conversations.conversations).toHaveLength(1); // the same conversation
  });

  it('STOP opts out; a follow-up that was scheduled is SUPPRESSED at send time (OPTED_OUT)', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'stop', OPTED_IN);
    await event(world, 'stop', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    expect(intentOf(world, 'stop').followUp!.status).toBe('SCHEDULED');
    await simulate(world, 'shopper_3002', 'STOP');
    advance(3);
    const res = await processDue(world);
    expect(res.body).toMatchObject({ sent: 0, suppressed: 1 });
    expect(intentOf(world, 'stop').followUp).toMatchObject({ status: 'SUPPRESSED', reason: 'OPTED_OUT' });
    expect(proactive(world)).toEqual([]);
    expect(world.events.events.map((e) => e.eventType)).toContain('FOLLOW_UP_SUPPRESSED');
  });

  it('asking for a person after a follow-up → HANDOFF; automation stops', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'human', OPTED_IN);
    await event(world, 'human', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    advance(3);
    await processDue(world);
    const handoff = await simulate(world, 'shopper_3002', 'Can I talk to a person please');
    expect(handoff.body.decision.action).toBe('HUMAN_HANDOFF');
    expect(intentOf(world, 'human').followUp!.status).toBe('HANDOFF');
    const after = await simulate(world, 'shopper_3002', 'hello?');
    expect(after.body.outbound_messages).toEqual([]);
  });

  it('an order before due_at: the follow-up is SUPPRESSED (ALREADY_CONVERTED) and never sent', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'order', OPTED_IN);
    await event(world, 'order', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    const order = await request(world.app)
      .post('/api/demo-storefront/orders')
      .set('Origin', TEST_ORIGIN)
      .send({ brand_id: 'brand_A', web_session_id: 'ws_order_000000', shopify_variant_id: SERUM_30 });
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ order_recorded: true, intent_converted: true, attributed: false });
    expect(intentOf(world, 'order')).toMatchObject({
      status: 'CONVERTED',
      followUp: { status: 'SUPPRESSED', reason: 'ALREADY_CONVERTED' },
    });
    expect(world.events.events.map((e) => e.eventType)).toContain('ORDER_CREATED');
    advance(10);
    expect((await processDue(world)).body.sent).toBe(0);
    expect(proactive(world)).toEqual([]);
  });

  it('a shopper without marketing consent → NOT_ELIGIBLE (NO_CONSENT)', async () => {
    const { world } = await setup();
    await signIn(world, 'ravi', NOT_OPTED_IN);
    await event(world, 'ravi', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    expect(intentOf(world, 'ravi').followUp).toMatchObject({ status: 'NOT_ELIGIBLE', reason: 'NO_CONSENT' });
  });

  it('"Need it today?" with no WhatsApp message → store-oriented follow-up; sending the prefilled text instead cancels it', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'store', OPTED_IN);
    const click = await event(world, 'store', {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    expect(intentOf(world, 'store').followUp).toMatchObject({ status: 'SCHEDULED', dueAt: '2026-10-05T10:01:00.000Z' });
    advance(1);
    await processDue(world);
    expect(proactive(world)[0]!.text).toContain('Looking for Vitamin C Glow Serum (30 ml) today?');

    expect(click.status).toBe(202);

    // A fresh shopper session: this time the customer does send the prefilled message.
    const other = await setup();
    await signIn(other.world, 'store2', OPTED_IN);
    const click2 = await event(other.world, 'store2', {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    expect(intentOf(other.world, 'store2').followUp!.status).toBe('SCHEDULED');
    await simulate(other.world, 'shopper_3002', click2.body.whatsapp.prefilled_text);
    expect(intentOf(other.world, 'store2')).toMatchObject({ tokenConsumedAt: expect.any(String) });
    expect(intentOf(other.world, 'store2').followUp).toMatchObject({
      status: 'NOT_ELIGIBLE',
      reason: 'CUSTOMER_ALREADY_IN_CONVERSATION',
    });
    other.advance(5);
    expect((await processDue(other.world)).body.sent).toBe(0);
    expect(proactive(other.world)).toEqual([]);
  });

  it('frequency limit: at most one proactive message per customer per 24 h', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'freq1', OPTED_IN);
    await event(world, 'freq1', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    await signIn(world, 'freq2', OPTED_IN);
    await event(world, 'freq2', { event_type: 'CHECKOUT_STARTED', shopify_variant_id: SERUM_30 });
    advance(3);
    const res = await processDue(world);
    expect(res.body).toMatchObject({ sent: 1, suppressed: 1 });
    expect(res.body.results.find((r: { outcome: string }) => r.outcome === 'SUPPRESSED').reason).toBe(
      'FREQUENCY_LIMIT',
    );
  });

  it('process-due is brand-scoped: BRAND_ADMIN only; another brand processes only its own', async () => {
    const { world, advance } = await setup();
    await signIn(world, 'scope', OPTED_IN);
    await event(world, 'scope', { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    advance(3);
    for (const user of ['radmin_A', 'platform']) expect((await processDue(world, user)).status, user).toBe(403);
    expect((await processDue(world, 'admin_b')).body.sent).toBe(0);
    expect((await processDue(world, 'admin_a')).body.sent).toBe(1);
  });
});

describe('demo storefront endpoints (local profile only)', () => {
  it('serve products and shoppers; refuse bad origins and unknown shoppers', async () => {
    const { world } = await setup();
    const products = await request(world.app).get('/api/demo-storefront/products?brand_id=brand_A');
    expect(products.body.products.length).toBe(10);
    expect(products.body.products[0].variants[0].shopify_variant_id).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
    const shoppers = await request(world.app).get('/api/demo-storefront/shoppers');
    expect(shoppers.body.shoppers.map((s: { marketing_consent: string }) => s.marketing_consent)).toEqual([
      'OPTED_IN',
      'NOT_OPTED_IN',
    ]);
    expect(
      (
        await request(world.app)
          .post('/api/demo-storefront/orders')
          .set('Origin', 'http://evil.test')
          .send({ brand_id: 'brand_A', web_session_id: 'ws_x_00000000' })
      ).status,
    ).toBe(403);
    expect((await signIn(world, 'nobody', 'gid://shopify/Customer/3001')).status).toBe(404);
    expect(
      (
        await request(world.app)
          .post('/api/demo-storefront/shopper-sign-in')
          .set('Origin', TEST_ORIGIN)
          .send({ brand_id: 'brand_A', shopper_id: OPTED_IN, ...session('x'), phone: '9820012345' })
      ).status,
    ).toBe(400);
  });

  it('are not mounted when the demo storefront is not wired (gcp profile)', async () => {
    const world = buildTestWorld({ demoStorefront: false });
    for (const [method, path] of [
      ['get', '/api/demo-storefront/products?brand_id=brand_A'],
      ['post', '/api/demo-storefront/shopper-sign-in'],
      ['post', '/api/demo-storefront/orders'],
    ] as const) {
      // Without the route, the path is just an unknown API path: 401 anonymously, 404 when signed in.
      const anonymous = await request(world.app)[method](path).set('Origin', TEST_ORIGIN).send({});
      expect(anonymous.status, path).toBe(401);
      const signedIn = await request(world.app)[method](path).set('Authorization', bearer('admin_a')).send({});
      expect(signedIn.status, path).toBe(404);
    }
  });
});
