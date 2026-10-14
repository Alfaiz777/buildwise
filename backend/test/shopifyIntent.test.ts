/**
 * L4: the real Shopify store → intent → WhatsApp. The storefront snippet posts to
 * /api/intents from the store's own origin; "Need it today?" returns a readable, URL-encoded
 * wa.me message that carries the intent token; the Brand Admin edits the allowed storefronts.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoBrandSettings } from '../src/application/demoSetup.js';
import { parseStorefrontOrigins } from '../src/domain/brandSettings.js';
import { bearer, buildTestWorld, refOf, TEST_ORIGIN, tokenOf } from './helpers.js';

type World = ReturnType<typeof buildTestWorld>;
const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
const SHOP = 'https://m6ccxz-wk.myshopify.com';
const SERUM_30 = 'gid://shopify/ProductVariant/2001';
let n = 0;

async function syncedWorld() {
  const world = buildTestWorld();
  await world.commerceSync.sync('brand_A', SYSTEM);
  return world;
}
const event = (world: World, body: Record<string, unknown>, origin = TEST_ORIGIN, session = 'ws_shopify_00001') =>
  request(world.app)
    .post('/api/intents')
    .set('Origin', origin)
    .send({
      brand_id: 'brand_A',
      web_session_id: session,
      visitor_id: 'vis_shopify_0001',
      client_event_id: `ce_${++n}`,
      ...body,
    });
const say = (world: World, ref: string, text: string) =>
  request(world.app)
    .post('/api/channels/simulator/messages')
    .set('Authorization', bearer('admin_a'))
    .send({ simulator_customer_ref: ref, client_message_id: `cm_${++n}`, content: { type: 'TEXT', text } });
const setOrigins = (world: World, origins: unknown, user = 'admin_a') =>
  request(world.app)
    .patch('/api/brand/settings/storefront-origins')
    .set('Authorization', bearer(user))
    .send({ origins });

describe('"Need it today?" → a readable, URL-encoded WhatsApp message with the token', () => {
  let world: World;
  beforeEach(async () => {
    world = await syncedWorld();
  });

  it('STORE_NEED and CHAT name the product and size; without a product the shopper asks for help', async () => {
    const need = await event(world, {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    const needText: string = need.body.whatsapp.prefilled_text;
    expect(needText).toMatch(
      /^Hi Brand brand_A! I'd like Vitamin C Glow Serum \(30 ml\) today\. Is it available at a store near me\?$/,
    );
    const chat = await event(
      world,
      { event_type: 'WHATSAPP_CLICK', entry: 'CHAT', shopify_variant_id: SERUM_30 },
      TEST_ORIGIN,
      'ws_shopify_00002',
    );
    expect(chat.body.whatsapp.prefilled_text).toMatch(
      /^Hi Brand brand_A! I have a question about Vitamin C Glow Serum \(30 ml\)\.$/,
    );
    const none = await event(world, { event_type: 'WHATSAPP_CLICK', entry: 'CHAT' }, TEST_ORIGIN, 'ws_shopify_00003');
    expect(none.body.whatsapp.prefilled_text).toMatch(/^Hi Brand brand_A! I'd like some help choosing a product\.$/);
    // The link carries exactly that text, encoded; nothing about the shopper is in it.
    expect(decodeURIComponent(need.body.whatsapp.wa_link.split('?text=')[1])).toBe(needText);
    expect(need.body.whatsapp.wa_link).not.toMatch(/ws_|vis_|int_|var_/);
  });

  it('the shopper sends it as is: the intent is bound, and the agent sees the words without "(ref …)"', async () => {
    const click = await event(world, {
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
    const prefilled: string = click.body.whatsapp.prefilled_text;
    const res = await say(world, 'shopper_wa', prefilled);
    expect(res.status).toBe(200);
    expect(world.intents.intents[0]!.tokenConsumedAt).not.toBeNull();
    expect(world.conversations.conversations[0]!.currentIntentId).toBe(world.intents.intents[0]!.intentId);
    expect(world.conversations.messages[0]!.text).toBe(
      "Hi Brand brand_A! I'd like Vitamin C Glow Serum (30 ml) today. Is it available at a store near me?",
    );
    expect(JSON.stringify(world.conversations.messages)).not.toContain(tokenOf(click.body.whatsapp));
    // The bound product answers straight away: a store search for that size (no location yet → it asks the area).
    expect(res.body.decision).toMatchObject({ action: 'STORE_DISCOVERY' });
    expect(res.body.outbound_messages[0].text).toContain('Vitamin C Glow Serum');
  });

  it('a rewritten message that keeps "(ref …)" binds the same way', async () => {
    const click = await event(world, { event_type: 'WHATSAPP_CLICK', entry: 'CHAT', shopify_variant_id: SERUM_30 });
    await say(world, 'shopper_wa', `Is it good for oily skin? ${refOf(click.body.whatsapp)}`);
    expect(world.intents.intents[0]!.tokenConsumedAt).not.toBeNull();
    expect(world.conversations.messages[0]!.text).toBe('Is it good for oily skin?');
  });
});

describe('Brand Console: storefronts allowed to send shopper events', () => {
  let world: World;
  beforeEach(async () => {
    world = await syncedWorld();
  });

  it('the Shopify store is refused until the Brand Admin adds it; then the snippet works cross-origin (CORS)', async () => {
    const before = await event(world, { event_type: 'STOREFRONT_VISIT' }, SHOP);
    expect(before.status).toBe(403);

    const saved = await setOrigins(world, ['http://localhost:5173', `${SHOP}/`, SHOP]);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ allowed_storefront_origins: ['http://localhost:5173', SHOP] });
    const settings = await request(world.app).get('/api/brand/settings').set('Authorization', bearer('admin_a'));
    expect(settings.body.allowed_storefront_origins).toEqual(['http://localhost:5173', SHOP]);

    const preflight = await request(world.app).options('/api/intents').set('Origin', SHOP);
    expect(preflight.status).toBe(204);
    const after = await event(world, { event_type: 'PRODUCT_DETAIL_VIEW', shopify_variant_id: SERUM_30 }, SHOP);
    expect(after.status).toBe(202);
    expect(after.headers['access-control-allow-origin']).toBe(SHOP);

    const audit = world.audit.brandEvents.filter((e) => e.action === 'STOREFRONT_ORIGINS_UPDATED');
    expect(audit).toEqual([
      expect.objectContaining({ brandId: 'brand_A', actorId: 'admin_a', result: 'SUCCESS', reasonCode: 'count=2' }),
    ]);
  });

  it('only exact https origins (http only for localhost), at most 10; nothing else is saved', async () => {
    for (const bad of [
      ['http://m6ccxz-wk.myshopify.com'],
      [`${SHOP}/products/x`],
      [`${SHOP}?a=1`],
      ['javascript:alert(1)'],
      ['not a url'],
      'https://one.example',
      Array.from({ length: 11 }, (_, i) => `https://s${i}.example`),
    ]) {
      const res = await setOrigins(world, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STOREFRONT_ORIGINS');
    }
    expect(parseStorefrontOrigins(['http://localhost:5173', 'HTTPS://Shop.Example.com'])).toEqual([
      'http://localhost:5173',
      'https://shop.example.com',
    ]);
    expect(world.brands.brands.find((b) => b.brandId === 'brand_A')!.settings.allowed_storefront_origins).toEqual([
      TEST_ORIGIN,
    ]);
  });

  it('only the brand’s own Brand Admin can change it; another brand’s admin changes their own brand only', async () => {
    expect(
      (
        await request(world.app)
          .patch('/api/brand/settings/storefront-origins')
          .send({ origins: [SHOP] })
      ).status,
    ).toBe(401);
    const otherBrand = await setOrigins(world, [SHOP], 'admin_b');
    expect(otherBrand.status).toBe(200);
    expect(world.brands.brands.find((b) => b.brandId === 'brand_A')!.settings.allowed_storefront_origins).toEqual([
      TEST_ORIGIN,
    ]);
    expect(world.brands.brands.find((b) => b.brandId === 'brand_B')!.settings.allowed_storefront_origins).toEqual([
      SHOP,
    ]);
  });

  it('Reset demo keeps the list (the demo settings keep the brand’s storefront origins)', () => {
    const kept = demoBrandSettings({
      current: { allowed_storefront_origins: [SHOP] },
      brandName: 'AquaSkin',
      holdMinutes: 20,
    });
    expect(kept.allowed_storefront_origins).toEqual([SHOP]);
  });
});
