/**
 * L4 fix: the WhatsApp button and bubble on the real Shopify store.
 * 1. CORS: the storefront routes run before the global CORS block, so a deployment with
 *    CORS_ALLOWED_ORIGINS (the console's own origins) still answers the Shopify store.
 * 2. GET /api/wa: the entry points are plain links; the redirect records the click and sends the
 *    shopper to wa.me at once (no async wait before navigation).
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { bearer, buildTestWorld } from './helpers.js';
import { FakeMeta } from './whatsappFakes.js';

type World = ReturnType<typeof buildTestWorld>;
const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
const SHOP = 'https://m6ccxz-wk.myshopify.com';
const CONSOLE = 'https://app.qwikspot.test';
let n = 0;

async function shopWorld(options: Parameters<typeof buildTestWorld>[0] = {}) {
  const world = buildTestWorld({ corsAllowedOrigins: [CONSOLE], ...options });
  await world.commerceSync.sync('brand_A', SYSTEM);
  const brand = world.brands.brands.find((b) => b.brandId === 'brand_A')!;
  brand.settings = { ...brand.settings, allowed_storefront_origins: [SHOP] };
  return world;
}
const post = (world: World, body: Record<string, unknown>, origin = SHOP) =>
  request(world.app)
    .post('/api/intents')
    .set('Origin', origin)
    .send({ brand_id: 'brand_A', web_session_id: 'ws_shop_000001', client_event_id: `ce_${++n}`, ...body });
const wa = (world: World, query: Record<string, string>, referer: string | null = `${SHOP}/products/mineral`) => {
  const req = request(world.app)
    .get('/api/wa')
    .query({ brand: 'brand_A', entry: 'STORE_NEED', session: 'ws_shop_000001', visitor: 'vis_shop_00001', ...query });
  return referer ? req.set('Referer', referer) : req;
};
const textOf = (location: string | undefined) => decodeURIComponent((location ?? '').split('?text=')[1] ?? '');

describe('CORS: the Shopify store gets answers even with CORS_ALLOWED_ORIGINS set (the gcp case)', () => {
  let world: World;
  beforeEach(async () => {
    world = await shopWorld();
  });

  it('the preflight and the POST from an allowed storefront carry Access-Control-Allow-Origin', async () => {
    const preflight = await request(world.app)
      .options('/api/intents')
      .set('Origin', SHOP)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(SHOP);
    expect(preflight.headers['access-control-allow-headers']).toMatch(/content-type/i);

    const res = await post(world, { event_type: 'STOREFRONT_VISIT' });
    expect(res.status).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe(SHOP);
    expect(res.body.whatsapp_available).toBe(true);
  });

  it('error responses for an allowed storefront are readable by the browser (CORS headers on 400 / 404)', async () => {
    const unknown = await post(world, {
      event_type: 'PRODUCT_VIEW',
      shopify_variant_id: 'gid://shopify/ProductVariant/999',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers['access-control-allow-origin']).toBe(SHOP);
    const invalid = await post(world, { event_type: 'NOT_AN_EVENT' });
    expect(invalid.status).toBe(400);
    expect(invalid.headers['access-control-allow-origin']).toBe(SHOP);
  });

  it('a storefront the brand does not allow: 403 and no CORS header; the console keeps its own CORS', async () => {
    const res = await post(world, { event_type: 'STOREFRONT_VISIT' }, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const consoleCall = await request(world.app).get('/api/health').set('Origin', CONSOLE);
    expect(consoleCall.headers['access-control-allow-origin']).toBe(CONSOLE);
  });

  it('whatsapp_available is false when the WhatsApp channel is on but the brand has no connected number', async () => {
    const off = await shopWorld({ whatsapp: new FakeMeta() });
    const res = await post(off, { event_type: 'STOREFRONT_VISIT' });
    expect(res.status).toBe(202);
    expect(res.body.whatsapp_available).toBe(false);
  });
});

describe('GET /api/wa — the storefront link that opens WhatsApp', () => {
  let world: World;
  beforeEach(async () => {
    world = await shopWorld();
  });

  it('from the allowed store: records the click and answers 302 to wa.me with the readable text and the token', async () => {
    const res = await wa(world, { variant: '2001' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/wa\.me\/910000000000\?text=/);
    expect(textOf(res.headers.location)).toMatch(
      /^Hi Brand brand_A! I'd like Vitamin C Glow Serum \(30 ml\) today\. Is it available at a store near me\?$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // Recorded exactly like POST /api/intents: the session's intent, with the variant, and one token.
    expect(world.intents.intents).toEqual([
      expect.objectContaining({ webSessionId: 'ws_shop_000001', variantId: 'var_2001', type: 'STORE_ORIENTED' }),
    ]);
    expect(world.tokens.tokens).toHaveLength(1);
    expect(res.headers.location).not.toMatch(/ws_|vis_|var_|int_/);
  });

  it('a variant GID and the CHAT entry work the same; without a variant the shopper asks for help', async () => {
    const chat = await wa(world, { entry: 'CHAT', variant: 'gid://shopify/ProductVariant/2001' });
    expect(textOf(chat.headers.location)).toMatch(
      /^Hi Brand brand_A! I have a question about Vitamin C Glow Serum \(30 ml\)\./,
    );
    const none = await wa(world, { entry: 'CHAT', session: 'ws_shop_000002' });
    expect(textOf(none.headers.location)).toMatch(/^Hi Brand brand_A! I'd like some help choosing a product\./);
  });

  it('the shopper who sends that message is bound to the browsing intent', async () => {
    const res = await wa(world, { variant: '2001' });
    const sent = await request(world.app)
      .post('/api/channels/simulator/messages')
      .set('Authorization', bearer('admin_a'))
      .send({
        simulator_customer_ref: 'shop_wa',
        client_message_id: 'cm_wa_1',
        content: { type: 'TEXT', text: textOf(res.headers.location) },
      });
    expect(sent.status).toBe(200);
    expect(world.intents.intents[0]!.tokenConsumedAt).not.toBeNull();
    expect(world.audit.brandEvents.find((e) => e.action === 'INTENT_TOKEN_BOUND')).toMatchObject({
      reasonCode: 'TEXT_MATCH',
    });
  });

  it('a page the brand does not allow (or no Referer): 302 to the plain brand chat, nothing recorded', async () => {
    for (const referer of ['https://evil.example/page', null]) {
      const res = await wa(world, { variant: '2001' }, referer);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        `https://wa.me/910000000000?text=${encodeURIComponent('Hi Brand brand_A! I have a question.')}`,
      );
    }
    expect(world.intents.intents).toEqual([]);
    expect(world.tokens.tokens).toEqual([]);
  });

  it('no WhatsApp number for the brand: back to the store page it came from', async () => {
    const brand = world.brands.brands.find((b) => b.brandId === 'brand_A')!;
    brand.settings = { ...brand.settings, messaging: { display_name: 'Brand brand_A', whatsapp_number: null } };
    const res = await wa(world, { variant: '2001' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${SHOP}/products/mineral`);
    // A page the brand does not allow is never a redirect target.
    const evil = await wa(world, { variant: '2001' }, 'https://evil.example/page');
    expect(evil.status).toBe(404);
  });

  it('only the strict fields: an extra or malformed field is refused (400), an unknown brand is 404', async () => {
    expect((await wa(world, { phone: '9876543210' })).status).toBe(400);
    expect((await wa(world, { session: 'short' })).status).toBe(400);
    expect((await wa(world, { variant: '12; drop' })).status).toBe(400);
    expect((await wa(world, { entry: 'OTHER' })).status).toBe(400);
    expect((await wa(world, { brand: 'brand_nope' })).status).toBe(404);
    expect(world.intents.intents).toEqual([]);
  });

  it('rate limited (6th click in a session within the hour): still opens the plain chat, logged without ids', async () => {
    const lines: string[] = [];
    const logged = await shopWorld({ logger: createLogger('debug', (l) => lines.push(l)) });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await wa(logged, { variant: '2001' }));
    expect(results.slice(0, 5).every((r) => textOf(r.headers.location).includes('Vitamin C Glow Serum'))).toBe(true);
    expect(results[5]!.status).toBe(302);
    expect(textOf(results[5]!.headers.location)).toBe('Hi Brand brand_A! I have a question.');
    const fallback = lines.map((l) => JSON.parse(l)).filter((l) => l.message === 'intents.wa_redirect_fallback');
    expect(fallback).toEqual([
      expect.objectContaining({ brand_id: 'brand_A', reason: 'RATE_LIMITED', to: 'WHATSAPP' }),
    ]);
    expect(lines.join('\n')).not.toMatch(/ws_shop|vis_shop|START_QWIKSPOT/);
  });
});
