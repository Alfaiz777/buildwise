import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashIntentToken } from '../src/domain/intentToken.js';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';

type World = ReturnType<typeof buildTestWorld>;
const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
const SERUM_30 = 'gid://shopify/ProductVariant/2001';

let n = 0;
const intentEvent = (world: World, body: Record<string, unknown>, origin: string | null = TEST_ORIGIN) => {
  const req = request(world.app).post('/api/intents');
  if (origin) req.set('Origin', origin);
  return req.send({
    brand_id: 'brand_A',
    web_session_id: 'ws_session_000001',
    visitor_id: 'vis_visitor_00001',
    client_event_id: `ce_${++n}`,
    ...body,
  });
};

const simulate = (world: World, userId: string, body: Record<string, unknown>) =>
  request(world.app).post('/api/channels/simulator/messages').set('Authorization', bearer(userId)).send(body);
const text = (ref: string, t: string, id = `cm_${++n}`) => ({
  simulator_customer_ref: ref,
  client_message_id: id,
  content: { type: 'TEXT', text: t },
});

async function syncedWorld(options: Parameters<typeof buildTestWorld>[0] = {}) {
  const world = buildTestWorld(options);
  await world.commerceSync.sync('brand_A', SYSTEM);
  await world.commerceSync.sync('brand_B', SYSTEM);
  return world;
}

describe('POST /api/intents (public storefront endpoint)', () => {
  let world: World;
  beforeEach(async () => {
    world = await syncedWorld();
  });

  it('records the event, classifies the session and returns stage, strength and type', async () => {
    const res = await intentEvent(world, { event_type: 'ADD_TO_CART', shopify_variant_id: SERUM_30 });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      accepted: true,
      intent_stage: 'CART',
      intent_strength: 'HIGH_INTENT',
      intent_type: 'CART_ABANDONMENT',
      whatsapp: null,
    });
    expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    const [intent] = world.intents.intents;
    expect(intent).toMatchObject({ customerId: null, productId: 'prd_1001', variantId: 'var_2001', status: 'ACTIVE' });
    expect(world.events.events.map((e) => e.eventType)).toEqual(['ADD_TO_CART']);
    expect(world.sunk.map((e) => e.eventType)).toEqual(['ADD_TO_CART']); // exported to the EventSink
  });

  it('is idempotent on brand + web_session_id + client_event_id', async () => {
    const body = { event_type: 'PRODUCT_DETAIL_VIEW', shopify_variant_id: SERUM_30, client_event_id: 'same_event' };
    await intentEvent(world, body);
    const replay = await intentEvent(world, body);
    expect(replay.status).toBe(202);
    expect(world.intents.intents[0]!.eventCount).toBe(1);
    expect(world.intents.intents[0]!.stage).toBe('PRODUCT_VIEW'); // not counted twice → not CONSIDERATION
    expect(world.events.events).toHaveLength(1);
  });

  it('refuses origins outside allowed_storefront_origins, and unknown brands, with 403 ORIGIN_NOT_ALLOWED', async () => {
    for (const [origin, brand] of [
      ['http://evil.test', 'brand_A'],
      [null, 'brand_A'],
      [TEST_ORIGIN, 'brand_nope'],
      [TEST_ORIGIN, 'brand_S'], // suspended
    ] as const) {
      const res = await intentEvent(world, { event_type: 'STOREFRONT_VISIT', brand_id: brand }, origin);
      expect(res.status, `${origin} ${brand}`).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect(world.intents.intents).toHaveLength(0);
  });

  it.each([
    ['PII field (phone)', { event_type: 'STOREFRONT_VISIT', phone: '9820012345' }],
    ['PII field (email)', { event_type: 'STOREFRONT_VISIT', email: 'a@b.test' }],
    ['unknown event type', { event_type: 'ORDER_CREATED' }],
    ['product event without a variant', { event_type: 'ADD_TO_CART' }],
    ['search without a term', { event_type: 'SEARCH' }],
    ['search term that looks like an email', { event_type: 'SEARCH', search_term: 'asha@example.com' }],
    ['search term that looks like a phone number', { event_type: 'SEARCH', search_term: '+91 98200 12345' }],
    ['WhatsApp click without entry', { event_type: 'WHATSAPP_CLICK' }],
    ['malformed session id', { event_type: 'STOREFRONT_VISIT', web_session_id: 'x' }],
  ])('%s → 400 INVALID_EVENT', async (_label, body) => {
    const res = await intentEvent(world, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_EVENT');
  });

  it('unknown variant → 404 UNKNOWN_VARIANT', async () => {
    const res = await intentEvent(world, {
      event_type: 'PRODUCT_VIEW',
      shopify_variant_id: 'gid://shopify/ProductVariant/999',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_VARIANT');
  });

  it('rate limits per IP (60/min) → 429', async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await intentEvent(world, { event_type: 'STOREFRONT_VISIT' })).status;
    expect(last).toBe(429);
  });

  it('a search keeps only the matched catalogue category on the intent; the raw term stays on the event', async () => {
    await intentEvent(world, { event_type: 'SEARCH', search_term: '  Vitamin C SERUM ' });
    expect(world.intents.intents[0]).toMatchObject({ type: 'SEARCH_EXPLORATION', matchedCategory: 'Serum' });
    expect(world.events.events[0]!.payload).toMatchObject({
      search_term: 'vitamin c serum',
      matched_category: 'Serum',
    });
  });

  it('WHATSAPP_CLICK issues a single-use token: 26 Crockford chars, hash stored, 30-min TTL, max 5 per session per hour', async () => {
    const res = await intentEvent(world, {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    expect(res.status).toBe(202);
    const token = res.body.whatsapp.prefilled_text.replace('START_BUILDWISE_', '');
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.body.whatsapp.wa_link).toBe(`https://wa.me/910000000000?text=START_BUILDWISE_${token}`);
    expect(res.body.intent_type).toBe('STORE_ORIENTED');
    const stored = world.tokens.tokens[0]!;
    expect(stored.tokenHash).toBe(hashIntentToken(token));
    expect(JSON.stringify(world.tokens.tokens)).not.toContain(token);
    expect(new Date(stored.expiresAt).getTime() - new Date(stored.issuedAt).getTime()).toBe(30 * 60 * 1000);

    for (let i = 0; i < 4; i++) {
      expect((await intentEvent(world, { event_type: 'WHATSAPP_CLICK', entry: 'CHAT' })).status).toBe(202);
    }
    const sixth = await intentEvent(world, { event_type: 'WHATSAPP_CLICK', entry: 'CHAT' });
    expect(sixth.status).toBe(429);
  });

  it('answers CORS preflight; the POST only echoes allowed origins', async () => {
    const pre = await request(world.app).options('/api/intents').set('Origin', 'https://theme.myshopify.test');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toBe('POST');
    const res = await intentEvent(world, { event_type: 'STOREFRONT_VISIT' }, 'https://theme.myshopify.test');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('simulator channel → ConversationPipeline', () => {
  let world: World;
  beforeEach(async () => {
    world = await syncedWorld();
  });

  it('first message creates the customer and conversation, persists messages, and replies with the fallback', async () => {
    const usersBefore = world.users.users.length;
    const res = await simulate(world, 'admin_a', text('customer_01', 'Hi there'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      conversation_id: expect.stringMatching(/^conv_/),
      inbound_message_id: expect.stringMatching(/^msg_/),
      decision: {
        action: 'NO_ACTION',
        runtime: 'MOCK',
        decision_source: 'DETERMINISTIC_FALLBACK',
        guardrail_status: 'ALLOWED',
        executed_action: null,
      },
    });
    expect(res.body.outbound_messages).toEqual([
      expect.objectContaining({ origin: 'AUTOMATED_REPLY', message_kind: 'SESSION', delivery_status: 'DELIVERED' }),
    ]);
    expect(world.customers.customers[0]).toMatchObject({
      channelIdentities: [{ channel: 'SIMULATOR', externalRef: 'sim:customer_01' }],
      consentState: 'UNKNOWN',
    });
    expect(world.users.users).toHaveLength(usersBefore); // a customer is never a console user
    expect(world.recommendations.recommendations[0]).toMatchObject({
      runtime: 'MOCK',
      decisionSource: 'DETERMINISTIC_FALLBACK',
      guardrailStatus: 'ALLOWED',
      action: 'NO_ACTION',
    });
    expect(world.events.events.map((e) => e.eventType)).toEqual([
      'CONVERSATION_STARTED',
      'MESSAGE_RECEIVED',
      'AI_DECISION',
      'MESSAGE_SENT',
    ]);

    const again = await simulate(world, 'admin_a', text('customer_01', 'Second message'));
    expect(again.body.conversation_id).toBe(res.body.conversation_id);
    expect(world.customers.customers).toHaveLength(1);
  });

  it('a replayed client_message_id returns the original result without re-running any stage', async () => {
    const body = text('customer_01', 'Hello', 'cm_fixed');
    const first = await simulate(world, 'admin_a', body);
    const messagesBefore = world.conversations.messages.length;
    const eventsBefore = world.events.events.length;
    const replay = await simulate(world, 'admin_a', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(world.conversations.messages).toHaveLength(messagesBefore);
    expect(world.events.events).toHaveLength(eventsBefore);
    expect(world.recommendations.recommendations).toHaveLength(1);
  });

  it('handshake: a valid token binds the intent + visitor, and is stripped from stored text', async () => {
    const click = await intentEvent(world, {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    const prefilled: string = click.body.whatsapp.prefilled_text;
    const token = prefilled.replace('START_BUILDWISE_', '');
    const res = await simulate(world, 'admin_a', text('customer_02', `${prefilled} Do you have it today?`));
    expect(res.status).toBe(200);

    const intent = world.intents.intents[0]!;
    const customer = world.customers.customers[0]!;
    expect(intent.customerId).toBe(customer.customerId);
    expect(intent.tokenConsumedAt).not.toBeNull();
    expect(world.conversations.conversations[0]!.currentIntentId).toBe(intent.intentId);
    expect([...world.visitors.links.values()][0]).toMatchObject({
      customerId: customer.customerId,
      linkSource: 'HANDSHAKE',
    });
    expect(res.body.outbound_messages[0].text).toContain('Vitamin C Glow Serum'); // stays on the product
    expect(JSON.stringify(world.conversations.messages)).not.toContain(token);
    expect(world.conversations.messages[0]!.text).toBe('Do you have it today?');
  });

  it('an invalid or reused token fails silently (no binding) and is audited; the conversation continues', async () => {
    const click = await intentEvent(world, {
      event_type: 'WHATSAPP_CLICK',
      entry: 'CHAT',
      shopify_variant_id: SERUM_30,
    });
    const prefilled: string = click.body.whatsapp.prefilled_text;
    await simulate(world, 'admin_a', text('customer_03', prefilled));
    const reused = await simulate(world, 'admin_a', text('customer_04', prefilled));
    expect(reused.status).toBe(200);
    expect(reused.body.outbound_messages[0].text).not.toMatch(/token|invalid|expired/i);
    const other = world.customers.customers.find((c) => c.displayRef === 'sim:customer_04')!;
    expect(world.intents.intents[0]!.customerId).not.toBe(other.customerId);
    expect(
      world.audit.brandEvents.filter((e) => e.action === 'INTENT_TOKEN_REJECTED').map((e) => e.reasonCode),
    ).toEqual(['TOKEN_ALREADY_USED']);
    // Another brand cannot use this brand's token either.
    const bad = await simulate(world, 'admin_b', text('customer_05', 'START_BUILDWISE_0123456789ABCDEFGHJKMNPQRS'));
    expect(bad.status).toBe(200);
  });

  it('STOP opts out and stops automated replies; a later message gets no reply', async () => {
    await simulate(world, 'admin_a', text('customer_06', 'hello'));
    const stop = await simulate(world, 'admin_a', text('customer_06', 'STOP'));
    expect(stop.body.outbound_messages).toEqual([]);
    expect(stop.body.decision).toMatchObject({ runtime: 'MOCK', policy_reason: 'OPT_OUT_REQUEST' });
    expect(world.customers.customers[0]!.consentState).toBe('OPTED_OUT');
    const later = await simulate(world, 'admin_a', text('customer_06', 'are you there?'));
    expect(later.body.outbound_messages).toEqual([]);
    expect(later.body.decision.policy_reason).toBe('OPTED_OUT');
  });

  it('asking for a person → HUMAN_HANDOFF once; afterwards no automated replies', async () => {
    const handoff = await simulate(world, 'admin_a', text('customer_07', 'I want to talk to a person'));
    expect(handoff.body.decision.action).toBe('HUMAN_HANDOFF');
    expect(handoff.body.outbound_messages[0].text).toMatch(/member of the Brand brand_A team/);
    expect(world.conversations.conversations[0]!.humanHandoff).toBe(true);
    expect(world.events.events.map((e) => e.eventType)).toContain('HUMAN_HANDOFF');
    const next = await simulate(world, 'admin_a', text('customer_07', 'hello?'));
    expect(next.body.outbound_messages).toEqual([]);
    expect(next.body.decision.policy_reason).toBe('HUMAN_HANDOFF');
  });

  it('per-conversation AI limit: after 10 decisions in 5 minutes, one wait notice, then silence', async () => {
    const outs: number[] = [];
    for (let i = 0; i < 12; i++)
      outs.push((await simulate(world, 'admin_a', text('customer_08', `msg ${i}`))).body.outbound_messages.length);
    expect(outs).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    expect(world.recommendations.recommendations).toHaveLength(10);
  });

  it('long text is truncated to 2,000 characters before storage', async () => {
    await simulate(world, 'admin_a', text('customer_09', 'a'.repeat(3000)));
    expect(world.conversations.messages[0]!.text).toHaveLength(2000);
  });

  it('refused for PLATFORM_ADMIN and RETAIL_ADMIN (403) and when the channel is disabled (404)', async () => {
    for (const userId of ['platform', 'radmin_A']) {
      expect((await simulate(world, userId, text('c', 'hi'))).status, userId).toBe(403);
    }
    const off = await syncedWorld({ channels: [] });
    const res = await simulate(off, 'admin_a', text('c', 'hi'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHANNEL_DISABLED');
  });

  it('rejects malformed simulator requests (400)', async () => {
    const res = await simulate(world, 'admin_a', {
      simulator_customer_ref: 'bad ref!',
      client_message_id: 'x',
      content: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('Brand Console conversation routes (brand-scoped)', () => {
  it('list, detail with intent and web events, intents list (anonymous included), simulator polling', async () => {
    const world = await syncedWorld();
    await intentEvent(world, { event_type: 'STOREFRONT_VISIT', web_session_id: 'ws_anonymous_0001' });
    const click = await intentEvent(world, {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    const sim = await simulate(world, 'admin_a', text('customer_10', click.body.whatsapp.prefilled_text));
    const admin = (path: string) => request(world.app).get(path).set('Authorization', bearer('admin_a'));

    const list = await admin('/api/brand/conversations');
    expect(list.body.conversations).toEqual([
      expect.objectContaining({
        conversation_id: sim.body.conversation_id,
        customer_ref: 'sim:customer_10',
        channel: 'SIMULATOR',
        human_handoff: false,
        intent: expect.objectContaining({ intent_type: 'STORE_ORIENTED', product_title: 'Vitamin C Glow Serum' }),
      }),
    ]);

    const detail = await admin(`/api/brand/conversations/${sim.body.conversation_id}`);
    expect(detail.body).toMatchObject({ brand_display_name: 'Brand brand_A', customer_ref: 'sim:customer_10' });
    expect(detail.body.web_events.map((e: { event_type: string }) => e.event_type)).toEqual(['WHATSAPP_CLICK']);
    expect(detail.body.messages.map((m: { origin: string }) => m.origin)).toEqual(['CUSTOMER', 'AUTOMATED_REPLY']);
    expect(detail.body.recommendations[0]).toMatchObject({
      runtime: 'MOCK',
      decision_source: 'DETERMINISTIC_FALLBACK',
    });

    const intents = await admin('/api/brand/intents');
    expect(intents.body.intents).toHaveLength(2);
    const anonymous = intents.body.intents.find((i: { anonymous: boolean }) => i.anonymous);
    expect(anonymous.who).toMatch(/^visitor [0-9a-f]{6}$/);
    expect(JSON.stringify(intents.body)).not.toContain('ws_anonymous_0001');
    expect((await admin('/api/brand/intents?type=VISIT_ONLY')).body.intents).toHaveLength(1);

    const poll = await admin(
      `/api/channels/simulator/conversations/${sim.body.conversation_id}/messages?after=${sim.body.inbound_message_id}`,
    );
    expect(poll.body.messages.map((m: { origin: string }) => m.origin)).toEqual(['AUTOMATED_REPLY']);

    // Another brand: 404; other scopes: 403.
    const other = (path: string, user: string) => request(world.app).get(path).set('Authorization', bearer(user));
    expect((await other(`/api/brand/conversations/${sim.body.conversation_id}`, 'admin_b')).status).toBe(404);
    expect(
      (await other(`/api/channels/simulator/conversations/${sim.body.conversation_id}/messages`, 'admin_b')).status,
    ).toBe(404);
    expect((await other('/api/brand/intents', 'admin_b')).body.intents).toEqual([]);
    for (const user of ['radmin_A', 'platform']) {
      for (const path of [
        '/api/brand/conversations',
        '/api/brand/intents',
        `/api/brand/conversations/${sim.body.conversation_id}`,
      ]) {
        expect((await other(path, user)).status, `${user} ${path}`).toBe(403);
      }
    }
  });
});
