/**
 * L2-WhatsApp (docs/06 §10): each brand connects its own number through Meta Embedded Signup
 * and the agent answers from that number; the simulator stays for every brand without one.
 * Real routes, the real HttpWhatsAppGraphApi and WhatsAppMessagingProvider against FakeMeta.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HttpWhatsAppGraphApi } from '../src/adapters/messaging/whatsappGraphApi.js';
import { WhatsAppMessagingProvider } from '../src/adapters/messaging/whatsappMessagingProvider.js';
import { maskPhoneNumber, whatsappDisplayRef } from '../src/domain/whatsappNumbers.js';
import type { Logger } from '../src/lib/logger.js';
import type { OutboundMessage } from '../src/ports/messaging.js';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';
import { FakeMeta, META_TEST_APP, metaSignature, waText, waWebhook } from './whatsappFakes.js';

const WABA_A = {
  wabaId: '100000000000001',
  code: 'signup-code-brand-a-0001',
  token: 'wa-business-token-brand-a',
  numbers: [{ id: '200000000000001', display: '+91 98765 43210', name: 'AquaSkin', quality: 'GREEN' }],
};
const WABA_B = {
  wabaId: '100000000000002',
  code: 'signup-code-brand-b-0002',
  token: 'wa-business-token-brand-b',
  numbers: [{ id: '200000000000002', display: '+91 91234 56789', name: 'Brand B Store', quality: 'GREEN' }],
};
const CUSTOMER = '919800011122';

function waWorld(meta = new FakeMeta([WABA_A, WABA_B]), logger?: Logger) {
  const world = buildTestWorld({ whatsapp: meta, logger });
  const as = (user: string) => ({
    post: (path: string, body: object = {}) =>
      request(world.app).post(path).set('Authorization', bearer(user)).send(body),
    get: (path: string) => request(world.app).get(path).set('Authorization', bearer(user)),
  });
  const connect = (user = 'admin_a', waba = WABA_A, phoneNumberId: string | null = waba.numbers[0]!.id) =>
    as(user).post('/api/integrations/whatsapp/connect', {
      code: waba.code,
      waba_id: waba.wabaId,
      ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}),
    });
  const webhook = async (body: object, signature?: string) => {
    const raw = JSON.stringify(body);
    const res = await request(world.app)
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature ?? metaSignature(raw))
      .send(raw);
    await world.whatsappWebhooks!.flush();
    return res;
  };
  return { world, meta, as, connect, webhook };
}

// ------------------------------------------------------------------------------------ connect

describe('Embedded Signup → connect (BRAND_ADMIN)', () => {
  it('exchanges the code, checks the number, subscribes the app, registers with a 6-digit PIN and stores it encrypted', async () => {
    const { world, meta, connect, as } = waWorld();
    const res = await connect();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      status: 'CONNECTED',
      display_phone_number: '+91 •••• 3210',
      verified_name: 'AquaSkin',
      quality_rating: 'GREEN',
      connected_at: expect.any(String),
      dev_number: false,
    });
    expect(meta.subscribed.has(WABA_A.wabaId)).toBe(true);
    expect(meta.registered.get(WABA_A.numbers[0]!.id)).toMatch(/^\d{6}$/);
    expect(meta.seen.find((s) => s.path.startsWith('/oauth/access_token'))?.method).toBe('GET');
    // Stored sealed; decrypts to the issued token; the number belongs to brand_A.
    expect(JSON.stringify(world.whatsappStore.docs.get('brand_A'))).not.toContain(WABA_A.token);
    expect(await world.whatsappStore.get('brand_A')).toMatchObject({
      businessToken: WABA_A.token,
      pin: '246813',
      phoneNumberId: WABA_A.numbers[0]!.id,
    });
    expect(await world.whatsappStore.brandForPhoneNumber(WABA_A.numbers[0]!.id)).toBe('brand_A');
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'WHATSAPP_CONNECTED', result: 'SUCCESS' });
    // Status for the console: masked, never the token.
    const status = await as('admin_a').get('/api/integrations/whatsapp');
    expect(status.body).toMatchObject({ status: 'CONNECTED', display_phone_number: '+91 •••• 3210' });
    expect(JSON.stringify(status.body)).not.toMatch(/98765 43210|wa-business-token|246813/);
  });

  it('Embedded Signup v4 may finish without a number id: the WABA’s only number is used', async () => {
    const { connect, world } = waWorld();
    expect((await connect('admin_a', WABA_A, null)).body.status).toBe('CONNECTED');
    expect(await world.whatsappStore.brandForPhoneNumber(WABA_A.numbers[0]!.id)).toBe('brand_A');
    const two = {
      ...WABA_B,
      numbers: [...WABA_B.numbers, { id: '200000000000009', display: '+91 1', name: 'x', quality: 'GREEN' }],
    };
    const res = await waWorld(new FakeMeta([two])).connect('admin_b', two, null);
    expect([res.status, res.body.error.code]).toEqual([400, 'WHATSAPP_NUMBER_REQUIRED']);
  });

  it('a number already connected to another brand is refused before anything changes for the second brand', async () => {
    // Brand B's signup somehow shares brand A's WABA and number.
    const shared = { ...WABA_A, code: 'signup-code-shared-0003', token: 'wa-business-token-shared' };
    const { connect, meta, world } = waWorld(new FakeMeta([WABA_A, shared]));
    await connect('admin_a');
    const registeredBefore = meta.registered.size;
    meta.subscribed.clear();
    const res = await connect('admin_b', shared);
    expect([res.status, res.body.error.code]).toEqual([409, 'WHATSAPP_NUMBER_TAKEN']);
    expect(meta.subscribed.size).toBe(0);
    expect(meta.registered.size).toBe(registeredBefore);
    expect(await world.whatsappStore.get('brand_B')).toBeNull();
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'WHATSAPP_CONNECTED', result: 'FAILED' });
  });

  it('a bad or expired code, a bad body, the wrong role, or no WhatsApp channel are refused', async () => {
    const { as, world } = waWorld();
    const bad = await as('admin_a').post('/api/integrations/whatsapp/connect', {
      code: 'expired-code-000000',
      waba_id: WABA_A.wabaId,
    });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'WHATSAPP_CODE_INVALID']);
    expect(JSON.stringify(bad.body)).not.toContain('raw message');
    const body = await as('admin_a').post('/api/integrations/whatsapp/connect', { code: 'x', waba_id: 'abc' });
    expect(body.body.error.code).toBe('INVALID_REQUEST');
    expect((await as('radmin_A').post('/api/integrations/whatsapp/connect', {})).status).toBe(403);
    expect(await world.whatsappStore.get('brand_A')).toBeNull();
    const plain = buildTestWorld();
    const off = await request(plain.app)
      .post('/api/integrations/whatsapp/connect')
      .set('Authorization', bearer('admin_a'))
      .send({ code: WABA_A.code, waba_id: WABA_A.wabaId });
    expect([off.status, off.body.error.code]).toEqual([409, 'WHATSAPP_NOT_CONFIGURED']);
    expect(
      (await request(plain.app).get('/api/integrations/whatsapp').set('Authorization', bearer('admin_a'))).body,
    ).toMatchObject({ enabled: false, status: 'NOT_CONNECTED' });
  });

  it('disconnect unsubscribes, deletes the token, releases the number and is audited', async () => {
    const { connect, as, meta, world } = waWorld();
    await connect();
    const res = await as('admin_a').post('/api/integrations/whatsapp/disconnect');
    expect(res.body).toMatchObject({ status: 'NOT_CONNECTED', display_phone_number: null });
    expect(meta.subscribed.has(WABA_A.wabaId)).toBe(false);
    expect(world.whatsappStore.docs.get('brand_A')).toMatchObject({ status: 'DISCONNECTED', business_token: null });
    expect(await world.whatsappStore.brandForPhoneNumber(WABA_A.numbers[0]!.id)).toBeNull();
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'WHATSAPP_DISCONNECTED' });
  });

  it('GET /api/public/meta-config gives the public ids only', async () => {
    const res = await request(waWorld().world.app).get('/api/public/meta-config');
    expect(res.body).toEqual({
      available: true,
      app_id: META_TEST_APP.appId,
      config_id: META_TEST_APP.esConfigId,
      graph_version: 'v26.0',
    });
    expect(JSON.stringify(res.body)).not.toContain(META_TEST_APP.appSecret);
    expect((await request(buildTestWorld().app).get('/api/public/meta-config')).body.available).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ webhook

describe('POST /api/webhooks/whatsapp', () => {
  it('GET: Meta’s subscription check answers the challenge only with the right verify token', async () => {
    const { world } = waWorld();
    const ok = await request(world.app)
      .get('/api/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': META_TEST_APP.verifyToken, 'hub.challenge': '1158201444' });
    expect([ok.status, ok.text]).toEqual([200, '1158201444']);
    const bad = await request(world.app)
      .get('/api/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  it('a bad signature → 401 and nothing happens', async () => {
    const { webhook, connect, world } = waWorld();
    await connect();
    const body = waWebhook(WABA_A.numbers[0]!.id, { messages: [waText(CUSTOMER, 'wamid.IN1', 'hi')] });
    const res = await webhook(body, metaSignature(JSON.stringify(body), 'not-the-app-secret'));
    expect(res.status).toBe(401);
    expect(world.conversations.conversations).toHaveLength(0);
  });

  it('an inbound message runs the same pipeline and the reply goes out from the brand’s own number', async () => {
    const { webhook, connect, meta, world } = waWorld();
    await connect();
    const res = await webhook(
      waWebhook(WABA_A.numbers[0]!.id, { messages: [waText(CUSTOMER, 'wamid.IN1', 'Is this good for oily skin?')] }),
    );
    expect(res.status).toBe(200);
    const conversation = world.conversations.conversations.find((c) => c.brandId === 'brand_A')!;
    expect(conversation.channel).toBe('WHATSAPP');
    const customer = (await world.customers.get('brand_A', conversation.customerId))!;
    expect(customer).toMatchObject({ consentState: 'OPTED_IN', displayRef: 'wa:••••1122' });
    expect(meta.sent).toHaveLength(1);
    expect(meta.sent[0]).toMatchObject({ phoneNumberId: WABA_A.numbers[0]!.id, token: WABA_A.token });
    expect(meta.sent[0]!.payload).toMatchObject({ messaging_product: 'whatsapp', to: CUSTOMER });
    const out = world.conversations.messages.filter((m) => m.direction === 'OUTBOUND');
    expect(out.at(-1)).toMatchObject({ deliveryStatus: 'SENT', externalMessageId: 'wamid.TEST1' });
  });

  it('a repeated wamid is processed once', async () => {
    const { webhook, connect, meta, world } = waWorld();
    await connect();
    const body = waWebhook(WABA_A.numbers[0]!.id, { messages: [waText(CUSTOMER, 'wamid.DUP', 'hello')] });
    await webhook(body);
    await webhook(body);
    expect(world.conversations.messages.filter((m) => m.direction === 'INBOUND')).toHaveLength(1);
    expect(meta.sent).toHaveLength(1);
  });

  it('cross-brand isolation: brand B’s number only ever touches brand B, with brand B’s token', async () => {
    const { webhook, connect, meta, world } = waWorld();
    await connect('admin_a', WABA_A);
    await connect('admin_b', WABA_B);
    await webhook(waWebhook(WABA_B.numbers[0]!.id, { messages: [waText(CUSTOMER, 'wamid.B1', 'hello')] }));
    expect(world.conversations.conversations.map((c) => c.brandId)).toEqual(['brand_B']);
    expect(meta.sent.map((s) => [s.phoneNumberId, s.token])).toEqual([[WABA_B.numbers[0]!.id, WABA_B.token]]);
  });

  it('an unknown number is logged by id only and ignored', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug() {},
      info: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
      warn: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
      error: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
    };
    const { webhook, world, meta } = waWorld(new FakeMeta([WABA_A]), logger);
    const res = await webhook(
      waWebhook('299999999999999', { messages: [waText(CUSTOMER, 'wamid.X', 'my secret text')] }),
    );
    expect(res.status).toBe(200);
    expect(world.conversations.conversations).toHaveLength(0);
    expect(meta.sent).toHaveLength(0);
    expect(lines.filter((l) => l.includes('whatsapp.'))).toEqual([
      JSON.stringify({ m: 'whatsapp.webhook_unknown_number', phone_number_id: '299999999999999' }),
    ]);
  });

  it('delivery statuses are stored and never move backwards; account and quality updates change status only', async () => {
    const { webhook, connect, world } = waWorld();
    await connect();
    const id = WABA_A.numbers[0]!.id;
    await webhook(waWebhook(id, { statuses: [{ id: 'wamid.S1', status: 'read', timestamp: '1791800010' }] }));
    await webhook(waWebhook(id, { statuses: [{ id: 'wamid.S1', status: 'delivered', timestamp: '1791800005' }] }));
    expect(world.whatsappStore.statuses.get('brand_A:wamid.S1')).toMatchObject({ status: 'READ' });
    await webhook(waWebhook(id, {}, 'phone_number_quality_update', WABA_A.wabaId));
    const q = waWebhook(id, {}, 'phone_number_quality_update', WABA_A.wabaId);
    (q.entry[0]!.changes[0]!.value as Record<string, unknown>).event = 'FLAGGED';
    await webhook(q);
    const a = waWebhook(id, {}, 'account_update', WABA_A.wabaId);
    (a.entry[0]!.changes[0]!.value as Record<string, unknown>).event = 'ACCOUNT_RESTRICTION';
    await webhook(a);
    expect(await world.whatsappStore.get('brand_A')).toMatchObject({ qualityRating: 'YELLOW', status: 'RESTRICTED' });
  });

  it('logs never carry phone numbers, tokens or message text', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
      info: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
      warn: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
      error: (m, f) => void lines.push(JSON.stringify({ m, ...f })),
    };
    const { webhook, connect } = waWorld(undefined, logger);
    await connect();
    await webhook(
      waWebhook(WABA_A.numbers[0]!.id, { messages: [waText(CUSTOMER, 'wamid.LOG', 'my private question about acne')] }),
    );
    const log = lines.join('\n');
    expect(log).not.toMatch(/919800011122|98765|wa-business-token|private question|246813/);
  });
});

// ------------------------------------------------------------------------------------ routing

describe('channel routing: WhatsApp per brand, the simulator for everyone else', () => {
  it('a brand without a connection stays on the simulator; WhatsApp sends nothing', async () => {
    const { world, meta } = waWorld();
    const res = await request(world.app)
      .post('/api/channels/simulator/messages')
      .set('Authorization', bearer('admin_a'))
      .send({ simulator_customer_ref: 'sim_only', client_message_id: 'cm_1', content: { type: 'TEXT', text: 'hi' } });
    expect(res.status).toBe(200);
    expect(res.body.outbound_messages[0]).toMatchObject({ delivery_status: 'DELIVERED' });
    expect(world.conversations.conversations[0]!.channel).toBe('SIMULATOR');
    expect(meta.sent).toHaveLength(0);
  });

  it('a connected brand’s simulator customers still get simulator replies', async () => {
    const { world, meta, connect } = waWorld();
    await connect();
    const res = await request(world.app)
      .post('/api/channels/simulator/messages')
      .set('Authorization', bearer('admin_a'))
      .send({ simulator_customer_ref: 'judge_1', client_message_id: 'cm_2', content: { type: 'TEXT', text: 'hi' } });
    expect(res.body.outbound_messages[0].delivery_status).toBe('DELIVERED');
    expect(meta.sent).toHaveLength(0);
  });

  it('“Need it today?” links to the brand’s connected number; Settings shows the number masked', async () => {
    const { world, connect, as } = waWorld();
    const before = await request(world.app).post('/api/intents').set('Origin', TEST_ORIGIN).send({
      brand_id: 'brand_A',
      web_session_id: 'ws_wa_link_0000001',
      visitor_id: 'vis_wa_link_000001',
      client_event_id: 'ce_wa_1',
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
    });
    expect(before.body.whatsapp.wa_link).not.toContain('919876543210');
    await connect();
    const after = await request(world.app).post('/api/intents').set('Origin', TEST_ORIGIN).send({
      brand_id: 'brand_A',
      web_session_id: 'ws_wa_link_0000002',
      visitor_id: 'vis_wa_link_000002',
      client_event_id: 'ce_wa_2',
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
    });
    expect(after.body.whatsapp.wa_link).toMatch(/^https:\/\/wa\.me\/919876543210\?text=START_QWIKSPOT_/);
    const settings = await as('admin_a').get('/api/brand/settings');
    expect(settings.body.channel).toEqual({
      mode: 'WHATSAPP',
      whatsapp: { display_phone_number: '+91 •••• 3210', verified_name: 'AquaSkin', status: 'CONNECTED' },
    });
    expect((await as('admin_b').get('/api/brand/settings')).body.channel).toEqual({
      mode: 'SIMULATOR',
      whatsapp: null,
    });
  });
});

// ------------------------------------------------------------------------------------ payloads

describe('WhatsAppMessagingProvider: OutboundMessage → Cloud API payloads', () => {
  const meta = new FakeMeta([WABA_A]);
  const provider = new WhatsAppMessagingProvider({
    appSecret: META_TEST_APP.appSecret,
    api: new HttpWhatsAppGraphApi(META_TEST_APP, { fetch: meta.fetch }),
    senderFor: async (brandId) =>
      brandId === 'brand_A' ? { phoneNumberId: WABA_A.numbers[0]!.id, token: WABA_A.token } : null,
  });
  const msg = (patch: Partial<OutboundMessage>): OutboundMessage => ({
    brandId: 'brand_A',
    customerId: 'c',
    conversationId: 'conv',
    externalCustomerRef: CUSTOMER,
    messageType: 'INTERACTIVE',
    text: 'Pick one',
    actionReference: null,
    outboundRequestId: 'out_1',
    ...patch,
  });

  it('reply buttons with an image header and the footer', () => {
    const [p] = provider.payloads(
      msg({
        options: [
          { optionId: 'hold:st_1', label: 'Pick up today' },
          { optionId: 'buy_online', label: 'Home delivery' },
        ],
        parts: { header: { type: 'IMAGE', url: 'https://x.test/a.png', alt: 'a' }, footer: 'Powered by Qwikspot' },
      }),
    );
    expect(p).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: CUSTOMER,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'image', image: { link: 'https://x.test/a.png' } },
        body: { text: 'Pick one' },
        footer: { text: 'Powered by Qwikspot' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'hold:st_1', title: 'Pick up today' } },
            { type: 'reply', reply: { id: 'buy_online', title: 'Home delivery' } },
          ],
        },
      },
    });
  });

  it('a list with sections and the list button; a CTA URL; a plain image; text', () => {
    const [list] = provider.payloads(
      msg({
        options: [
          { optionId: 'hold:a', label: 'Bandra Store', description: '0.7 km', section: 'Stores near you' },
          { optionId: 'buy_online', label: 'Home delivery', description: '4–5 days', section: 'Or' },
        ],
        parts: { listButton: 'Choose a store' },
      }),
    );
    expect(list).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        action: {
          button: 'Choose a store',
          sections: [
            { title: 'Stores near you', rows: [{ id: 'hold:a', title: 'Bandra Store', description: '0.7 km' }] },
            { title: 'Or', rows: [{ id: 'buy_online', title: 'Home delivery', description: '4–5 days' }] },
          ],
        },
      },
    });
    const [cta] = provider.payloads(msg({ parts: { ctaUrl: { label: 'Open', url: 'https://x.test' } } }));
    expect(cta).toMatchObject({
      interactive: {
        type: 'cta_url',
        action: { name: 'cta_url', parameters: { display_text: 'Open', url: 'https://x.test' } },
      },
    });
    const [image] = provider.payloads(
      msg({ messageType: 'TEXT', parts: { header: { type: 'IMAGE', url: 'https://x.test/i.png', alt: 'i' } } }),
    );
    expect(image).toMatchObject({ type: 'image', image: { link: 'https://x.test/i.png', caption: 'Pick one' } });
    const [text] = provider.payloads(msg({ messageType: 'TEXT', text: 'See https://x.test' }));
    expect(text).toMatchObject({ type: 'text', text: { body: 'See https://x.test', preview_url: true } });
  });

  it('a location part is a second location message; a template carries its body parameters', () => {
    const both = provider.payloads(
      msg({
        messageType: 'TEXT',
        text: 'Ready',
        parts: { location: { name: 'Andheri Store', address: 'Andheri', latitude: 19.1, longitude: 72.8 } },
      }),
    );
    expect(both.map((p) => p.type)).toEqual(['text', 'location']);
    expect(both[1]).toMatchObject({ location: { name: 'Andheri Store', latitude: 19.1, longitude: 72.8 } });
    const [template] = provider.payloads(
      msg({
        messageType: 'TEMPLATE',
        templateName: 'qwikspot_cart_reminder_v1',
        templateParameters: ['AquaSkin', 'Vitamin C Glow Serum (30 ml)'],
      }),
    );
    expect(template).toMatchObject({
      type: 'template',
      template: {
        name: 'qwikspot_cart_reminder_v1',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'AquaSkin' },
              { type: 'text', text: 'Vitamin C Glow Serum (30 ml)' },
            ],
          },
        ],
      },
    });
  });

  it('send: the brand’s own sender; no connection → WHATSAPP_NOT_CONNECTED; outside the window → OUTSIDE_SERVICE_WINDOW', async () => {
    expect(await provider.send(msg({ messageType: 'TEXT', text: 'hi' }))).toMatchObject({ status: 'SENT' });
    expect(meta.sent.at(-1)).toMatchObject({ token: WABA_A.token });
    expect(await provider.send(msg({ brandId: 'brand_B', messageType: 'TEXT', text: 'hi' }))).toEqual({
      status: 'FAILED',
      externalMessageId: null,
      errorCode: 'WHATSAPP_NOT_CONNECTED',
    });
    meta.sendErrorCode = 131047;
    expect(await provider.send(msg({ messageType: 'TEXT', text: 'hi' }))).toMatchObject({
      status: 'FAILED',
      errorCode: 'OUTSIDE_SERVICE_WINDOW',
    });
    expect(
      await provider.send(msg({ externalCustomerRef: 'sim:judge_1', messageType: 'TEXT', text: 'hi' })),
    ).toMatchObject({
      errorCode: 'NOT_A_WHATSAPP_CUSTOMER',
    });
  });

  it('masks: numbers and customer refs never show in full', () => {
    expect(maskPhoneNumber('+91 98765 43210')).toBe('+91 •••• 3210');
    expect(maskPhoneNumber('15550001111')).toBe('•••• 1111');
    expect(whatsappDisplayRef('919800011122')).toBe('wa:••••1122');
  });
});
