/**
 * L2-Shopify (docs/06 §2, §8, §8.1, §9, §17.1): OAuth connect / callback / disconnect,
 * the GraphQL provider and sync, token refresh, and the orders/create and app/uninstalled
 * webhooks — through the real routes and the real ShopifyHttpAdminApi against FakeShopify
 * (recorded fixtures; no network).
 */
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ShopifyHttpAdminApi } from '../src/adapters/commerce/shopifyAdminApi.js';
import { ShopifyCommerceProvider } from '../src/adapters/commerce/shopifyCommerceProvider.js';
import { MockCommerceProvider } from '../src/adapters/commerce/mockCommerceProvider.js';
import { CommerceSyncService, SHOPIFY_CONNECTION_ID } from '../src/application/commerceSyncService.js';
import { htmlToText, parseDescription } from '../src/domain/shopifyDescription.js';
import {
  normalizeShopDomain,
  readState,
  signState,
  verifyCallbackHmac,
  verifyWebhookHmac,
} from '../src/domain/shopifyOAuth.js';
import { TokenCipher } from '../src/lib/tokenCipher.js';
import { ShopifyApiError } from '../src/ports/shopify.js';
import { bearer, buildTestWorld } from './helpers.js';
import { MemoryInsightsReader } from './memoryInsights.js';
import { FakeShopify, SHOPIFY_TEST_APP, signedCallback, TEST_SHOP, webhookHmac } from './shopifyFakes.js';
import { shopifyVariantNumber, createToolHandlers } from '../src/application/agent/tools.js';
import { OnlineStockService } from '../src/application/onlineStock.js';
import { ShopifyCatalogRefresh } from '../src/application/shopifyCatalogRefresh.js';
import { decorateOnlineLinks, linksToOnlineStore, withShopifyCartAttribute } from '../src/domain/attributionRef.js';

const NOW = new Date('2026-10-07T06:30:00.000Z');

// ------------------------------------------------------------------------------------ pure checks

describe('shop domain, callback HMAC, state, webhook HMAC (pure)', () => {
  it.each([
    ['m6ccxz-wk.myshopify.com', 'm6ccxz-wk.myshopify.com'],
    ['  AquaSkin-Test.MyShopify.com ', 'aquaskin-test.myshopify.com'],
    ['x.myshopify.com.evil.example', null],
    ['evil.example', null],
    ['-bad.myshopify.com', null],
    ['shop.myshopify.com/admin', null],
    ['https://shop.myshopify.com', null],
    [42, null],
  ])('%s → %s', (raw, expected) => expect(normalizeShopDomain(raw)).toBe(expected));

  it('callback HMAC: sorted params, hex, timing-safe; any tampered value or other secret fails', () => {
    const q = signedCallback({ code: 'c0de', shop: TEST_SHOP, state: 's', timestamp: '1759800000', host: 'aG9zdA' });
    expect(verifyCallbackHmac(q, SHOPIFY_TEST_APP.apiSecret)).toBe(true);
    expect(verifyCallbackHmac({ ...q, shop: 'other.myshopify.com' }, SHOPIFY_TEST_APP.apiSecret)).toBe(false);
    expect(verifyCallbackHmac(q, 'another-secret')).toBe(false);
    const { hmac: _hmac, ...unsigned } = q;
    expect(verifyCallbackHmac(unsigned, SHOPIFY_TEST_APP.apiSecret)).toBe(false);
  });

  it('state: signed, bound to brand + user + shop, expires; tampering fails', () => {
    const state = { nonce: 'n'.repeat(24), brandId: 'brand_A', userId: 'admin_a', shop: TEST_SHOP, exp: 1_000 };
    const token = signState(state, 'secret');
    expect(readState(token, 'secret', 999)).toEqual({ ok: true, state });
    expect(readState(token, 'secret', 1_001)).toEqual({ ok: false, reason: 'STATE_EXPIRED' });
    expect(readState(token, 'other', 999)).toEqual({ ok: false, reason: 'INVALID_STATE' });
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), b: 'brand_B' }),
    ).toString('base64url');
    expect(readState(`${forged}.${mac}`, 'secret', 999)).toEqual({ ok: false, reason: 'INVALID_STATE' });
    expect(readState('garbage', 'secret', 999)).toEqual({ ok: false, reason: 'INVALID_STATE' });
  });

  it('webhook HMAC is checked on the raw bytes', () => {
    const raw = Buffer.from('{"id":1}');
    expect(verifyWebhookHmac(raw, webhookHmac('{"id":1}'), SHOPIFY_TEST_APP.apiSecret)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from('{"id":2}'), webhookHmac('{"id":1}'), SHOPIFY_TEST_APP.apiSecret)).toBe(false);
    expect(verifyWebhookHmac(raw, undefined, SHOPIFY_TEST_APP.apiSecret)).toBe(false);
  });

  it('tokens are sealed with AES-256-GCM: fresh IV, unreadable, fail with another key or when tampered', () => {
    const cipher = new TokenCipher(Buffer.alloc(32, 1));
    const a = cipher.seal('shpua_secret_token');
    const b = cipher.seal('shpua_secret_token');
    expect(a.iv).not.toBe(b.iv);
    expect(JSON.stringify(a)).not.toContain('shpua_secret_token');
    expect(cipher.open(a)).toBe('shpua_secret_token');
    expect(() => new TokenCipher(Buffer.alloc(32, 2)).open(a)).toThrow();
    expect(() => cipher.open({ ...a, ciphertext: Buffer.from('tampered').toString('base64') })).toThrow();
  });
});

describe('product descriptions → text and attributes', () => {
  it('strips HTML, decodes entities, keeps line breaks and lifts the known "Label: value" lines', () => {
    const html =
      '<p>A lightweight brightening serum.</p><p><strong>Best for:</strong> dull skin</p><p>Skin type: oily, combination</p>' +
      '<p>Key ingredients: 10% vitamin C &amp; vitamin E</p><ul><li>Texture: gel</li><li>Fragrance: none</li></ul><p>When to use: mornings</p>';
    expect(parseDescription(html)).toEqual({
      text: 'A lightweight brightening serum.\n• Fragrance: none',
      attributes: {
        best_for: 'dull skin',
        skin_type: 'oily, combination',
        key_ingredients: '10% vitamin C & vitamin E',
        texture: 'gel',
        when_to_use: 'mornings',
      },
    });
    expect(htmlToText('<script>alert(1)</script>Hi&nbsp;there<br/>&#8377;795')).toBe('Hi there\n₹795');
  });
});

// ------------------------------------------------------------------------------------ provider

describe('ShopifyCommerceProvider (GraphQL Admin API, recorded fixtures)', () => {
  const provider = (fake: FakeShopify, sleeps: number[] = []) =>
    new ShopifyCommerceProvider(
      new ShopifyHttpAdminApi(SHOPIFY_TEST_APP, {
        fetch: fake.fetch,
        sleep: async (ms) => void sleeps.push(ms),
      }),
      TEST_SHOP,
      async () => 'shpua_test_access_1',
    );

  it('paginates products into the normalized shape: SKU, barcode, INR price, image, handle, category, attributes', async () => {
    const fake = new FakeShopify();
    const products = await provider(fake).getProducts();
    expect(products.map((p) => p.title)).toEqual([
      'Vitamin C Glow Serum',
      'Micellar Cleansing Water',
      'Hydrating Lip Balm',
    ]);
    expect(products[0]).toMatchObject({
      externalProductId: 'gid://shopify/Product/9001',
      handle: 'vitamin-c-glow-serum',
      category: 'Serum',
      status: 'ACTIVE',
      imageUrl: 'https://cdn.shopify.com/s/files/1/demo/vitamin-c.png',
      description: 'A lightweight brightening serum for a fresh, even glow.',
      attributes: { skin_type: 'oily, combination', key_ingredients: '10% vitamin C, ferulic acid & vitamin E' },
    });
    expect(products[0]!.variants[0]).toEqual({
      externalVariantId: 'gid://shopify/ProductVariant/7001',
      externalProductId: 'gid://shopify/Product/9001',
      sku: 'DBC-VCSERUM-30',
      barcode: '8906123000014',
      title: '30 ml',
      price: 795,
      currency: 'INR',
      status: 'ACTIVE',
    });
    expect(products[1]).toMatchObject({ status: 'ACTIVE', category: null, imageUrl: null }); // UNLISTED is sellable
    expect(products[2]).toMatchObject({ status: 'DRAFT', variants: [expect.objectContaining({ price: 249 })] });
    // Every call went to the pinned API version with the token header; the second page used the cursor.
    const calls = fake.seen.filter((s) => s.operation === 'QwikspotProducts');
    expect(calls.map((c) => c.url)).toEqual([
      `https://${TEST_SHOP}/admin/api/2026-10/graphql.json`,
      `https://${TEST_SHOP}/admin/api/2026-10/graphql.json`,
    ]);
    expect(calls[1]!.variables).toEqual({ after: 'cursor-page-1' });
  });

  it('backs off on THROTTLED (cost-based wait) and retries; gives up after the retry budget', async () => {
    const fake = new FakeShopify();
    const throttled = (await import('./fixtures/shopify/throttled.json', { with: { type: 'json' } })).default;
    fake.queue('QwikspotProducts', throttled);
    const sleeps: number[] = [];
    expect(await provider(fake, sleeps).getProducts()).toHaveLength(3);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500); // (52 − 2) / 100 per s = 500 ms
    const busy = new FakeShopify();
    for (let i = 0; i < 6; i++) busy.queue('QwikspotProducts', throttled);
    await expect(provider(busy).getProducts()).rejects.toMatchObject({ kind: 'THROTTLED' });
  });

  it('a rejected token is UNAUTHORIZED, with no provider message or token in the error', async () => {
    const fake = new FakeShopify();
    fake.revoked.add('shpua_test_access_1');
    const err = await provider(fake)
      .getProducts()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err).toMatchObject({ kind: 'UNAUTHORIZED' });
    expect(String((err as Error).message)).not.toMatch(/shpua|Invalid API key/);
  });
});

// ------------------------------------------------------------------------------------ OAuth

function shopifyWorld(fake = new FakeShopify(), now = () => NOW) {
  const world = buildTestWorld({ shopify: fake, now });
  const as = (user: string) => ({
    post: (path: string, body: object = {}) =>
      request(world.app).post(path).set('Authorization', bearer(user)).send(body),
    get: (path: string) => request(world.app).get(path).set('Authorization', bearer(user)),
  });
  /** Connect → the authorize URL → Shopify's signed redirect back to the callback. */
  const connect = async (
    user = 'admin_a',
    shop = TEST_SHOP,
    tamper: (q: Record<string, string>) => void = () => {},
  ) => {
    const res = await as(user).post('/api/integrations/shopify/connect', { shop });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const authorize = new URL(res.body.authorize_url);
    const query = signedCallback({
      code: 'auth-code-123',
      shop,
      state: authorize.searchParams.get('state')!,
      timestamp: String(Math.floor(NOW.getTime() / 1000)),
      host: Buffer.from(`admin.shopify.com/store/${shop.split('.')[0]}`).toString('base64url'),
    });
    tamper(query);
    const callback = await request(world.app).get('/api/integrations/shopify/callback').query(query);
    return { authorize, query, callback, location: String(callback.headers.location) };
  };
  return { world, fake, as, connect };
}

async function connected() {
  const w = shopifyWorld();
  await w.connect();
  await w.as('admin_a').post('/api/integrations/shopify/sync');
  const brand = w.world.brands.brands.find((b) => b.brandId === 'brand_A')!;
  brand.settings = {
    ...brand.settings,
    online_store: { product_url_template: 'https://aquaskin.example/products/{product_id}' },
  };
  return w;
}

describe('OAuth connect → callback → disconnect', () => {
  it('connect validates the shop and returns the authorize URL (client id, scopes, our callback, signed state)', async () => {
    const { as, world } = shopifyWorld();
    for (const shop of ['', 'evil.example', 'x.myshopify.com.evil.example']) {
      const bad = await as('admin_a').post('/api/integrations/shopify/connect', { shop });
      expect([bad.status, bad.body.error.code]).toEqual([400, 'INVALID_SHOP_DOMAIN']);
    }
    const res = await as('admin_a').post('/api/integrations/shopify/connect', { shop: 'AquaSkin-Test.myshopify.com' });
    const url = new URL(res.body.authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${TEST_SHOP}/admin/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe(SHOPIFY_TEST_APP.apiKey);
    expect(url.searchParams.get('scope')).toBe('read_products,read_inventory,read_customers,read_orders');
    expect(url.searchParams.get('redirect_uri')).toBe('https://tunnel.example.test/api/integrations/shopify/callback');
    expect(url.searchParams.get('state')).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(JSON.stringify(res.body)).not.toContain(SHOPIFY_TEST_APP.apiSecret);
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'SHOPIFY_CONNECT_STARTED', actorId: 'admin_a' });
    // Only the Brand Admin; mock mode says Shopify is not configured.
    expect((await as('radmin_A').post('/api/integrations/shopify/connect', { shop: TEST_SHOP })).status).toBe(403);
    const mock = buildTestWorld();
    const off = await request(mock.app)
      .post('/api/integrations/shopify/connect')
      .set('Authorization', bearer('admin_a'))
      .send({ shop: TEST_SHOP });
    expect([off.status, off.body.error.code]).toEqual([409, 'SHOPIFY_NOT_CONFIGURED']);
  });

  it('a valid callback exchanges the code for an expiring offline token, stores it encrypted, registers the webhooks once, and redirects', async () => {
    const { world, fake, connect, as } = shopifyWorld();
    const { callback, location } = await connect();
    expect(callback.status).toBe(302);
    expect(location).toBe('http://localhost:5173/brand/settings?shopify=connected');
    const token = fake.seen.find((s) => s.operation === 'TOKEN')!;
    expect(new URLSearchParams(token.body).get('expiring')).toBe('1');
    expect(new URLSearchParams(token.body).get('code')).toBe('auth-code-123');

    // Stored sealed; decrypts to the issued tokens; the shop belongs to brand_A.
    const raw = JSON.stringify(world.shopifyStore.secrets.get('brand_A'));
    expect(raw).not.toMatch(/shpua_test_access_1|shprt_test_refresh_1/);
    expect(await world.shopifyStore.get('brand_A')).toMatchObject({
      shopDomain: TEST_SHOP,
      shopName: 'AquaSkin',
      accessToken: `shpua_test_access_1`,
      refreshToken: 'shprt_test_refresh_1',
      accessTokenExpiresAt: '2026-10-07T07:30:00.000Z',
    });
    expect(await world.shopifyStore.brandForShop(TEST_SHOP)).toBe('brand_A');
    expect(fake.webhooks.map((w) => [w.topic, w.uri])).toEqual(
      [
        'ORDERS_CREATE',
        'ORDERS_CANCELLED',
        'PRODUCTS_CREATE',
        'PRODUCTS_UPDATE',
        'PRODUCTS_DELETE',
        'APP_UNINSTALLED',
      ].map((topic) => [topic, 'https://tunnel.example.test/api/webhooks/shopify']),
    );
    expect(world.audit.brandEvents.map((e) => e.action)).toContain('SHOPIFY_CONNECTED');

    // The connection says CONNECTED with the shop — and never a credential.
    const connections = await as('admin_a').get('/api/brand/connections');
    expect(connections.body.connections).toEqual([
      expect.objectContaining({
        status: 'CONNECTED',
        shop_domain: TEST_SHOP,
        shop_name: 'AquaSkin',
        source: 'SHOPIFY',
      }),
    ]);
    const everything = JSON.stringify([connections.body, callback.headers]);
    for (const secret of [
      'shpua_',
      'shprt_',
      SHOPIFY_TEST_APP.apiSecret,
      SHOPIFY_TEST_APP.encryptionKey.toString('base64'),
    ])
      expect(everything).not.toContain(secret);

    // Connecting again (a new state) never duplicates the webhooks.
    await connect();
    expect(fake.webhooks).toHaveLength(6);
  });

  /** Changes the callback's parameters; `resign` = sign them again (as a real Shopify would have). */
  it.each<[string, Record<string, string>, boolean, string]>([
    ['a parameter changed after signing', { code: 'other-code' }, false, 'INVALID_HMAC'],
    ['a forged state (correctly signed query)', { state: 'abc.def' }, true, 'INVALID_STATE'],
    ['another shop than the one asked for', { shop: 'other-shop.myshopify.com' }, true, 'SHOP_MISMATCH'],
  ])('%s → redirect with reason, nothing stored', async (_name, changes, resign, reason) => {
    const { world, connect } = shopifyWorld();
    const { location } = await connect('admin_a', TEST_SHOP, (q) => {
      const { hmac, ...params } = q;
      const changed = { ...params, ...changes };
      for (const key of Object.keys(q)) delete q[key];
      Object.assign(q, resign ? signedCallback(changed) : { ...changed, hmac: hmac! });
    });
    expect(location).toBe(`http://localhost:5173/brand/settings?shopify=error&reason=${reason}`);
    expect(world.shopifyStore.secrets.size).toBe(0);
  });

  it('the state is single-use (replay fails) and expires after 10 minutes', async () => {
    let now = NOW;
    const { world, connect } = shopifyWorld(new FakeShopify(), () => now);
    const first = await connect();
    expect(first.location).toContain('shopify=connected');
    const replay = await request(world.app).get('/api/integrations/shopify/callback').query(first.query);
    expect(replay.headers.location).toContain('reason=INVALID_STATE');

    const late = await connect('admin_a', TEST_SHOP, () => {
      now = new Date(NOW.getTime() + 11 * 60_000);
    });
    expect(late.location).toContain('reason=STATE_EXPIRED');
  });

  it('a failed token exchange and a shop already connected to another brand are refused', async () => {
    const fake = new FakeShopify();
    const { connect } = shopifyWorld(fake);
    fake.tokenStatus = 400;
    expect((await connect()).location).toContain('reason=TOKEN_EXCHANGE_FAILED');
    fake.tokenStatus = 200;
    expect((await connect('admin_a')).location).toContain('shopify=connected');
    expect((await connect('admin_b')).location).toContain('reason=SHOP_ALREADY_CONNECTED');
  });

  it('disconnect deletes the token and the shop claim, removes our webhooks and is audited', async () => {
    const { world, fake, connect, as } = shopifyWorld();
    await connect();
    const res = await as('admin_a').post('/api/integrations/shopify/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'DISCONNECTED', shop_domain: TEST_SHOP });
    expect(JSON.stringify(res.body)).not.toMatch(/shpua_|shprt_/);
    expect(world.shopifyStore.secrets.size).toBe(0);
    expect(await world.shopifyStore.brandForShop(TEST_SHOP)).toBeNull();
    expect(fake.webhooks).toHaveLength(0);
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'SHOPIFY_DISCONNECTED', result: 'SUCCESS' });
  });
});

// ------------------------------------------------------------------------------------ sync

describe('sync from the connected store', () => {
  it('without a connection → 409 SHOPIFY_NOT_CONNECTED', async () => {
    const { as } = shopifyWorld();
    const res = await as('admin_a').post('/api/integrations/shopify/sync');
    expect([res.status, res.body.error.code]).toEqual([409, 'SHOPIFY_NOT_CONNECTED']);
  });

  it('replaces a seeded mock catalogue: Shopify variants map, mock ones are archived — idempotent, same response shape', async () => {
    const { world, connect, as } = shopifyWorld();
    // The demo brand was seeded from the mock catalogue (same SKUs and barcodes as the store).
    await new CommerceSyncService({ commerce: new MockCommerceProvider(), ...world }).sync('brand_A', {
      type: 'SYSTEM',
      id: 'seed',
    });
    await connect();
    const res = await as('admin_a').post('/api/integrations/shopify/sync');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'CONNECTED',
      source: 'SHOPIFY',
      shop_domain: TEST_SHOP,
      shop_name: 'AquaSkin',
      product_count: 3,
      variant_count: 5,
    });
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'connection_id',
        'provider',
        'source',
        'status',
        'shop_domain',
        'shop_name',
        'connected_at',
        'last_sync_at',
        'last_error',
        'product_count',
        'variant_count',
      ].sort(),
    );
    const variants = await world.products.listVariants('brand_A');
    const live = variants.find((v) => v.sku === 'DBC-VCSERUM-30' && v.status !== 'ARCHIVED')!;
    expect(live).toMatchObject({ variantId: 'var_7001', canonicalSku: 'DBC-VCSERUM-30' });
    expect(variants.filter((v) => v.canonicalSku === 'DBC-VCSERUM-30')).toHaveLength(1); // never a conflict
    const mock = variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/2001')!;
    expect(mock).toMatchObject({ status: 'ARCHIVED', canonicalSku: null });
    const product = (await world.products.listProducts('brand_A')).find((p) => p.productId === 'prd_9001')!;
    expect(product).toMatchObject({ handle: 'vitamin-c-glow-serum', attributes: { skin_type: 'oily, combination' } });

    // Retail stock now maps to the live variants — barcode shared with the archived mock variant included.
    const csv =
      'store_id,store_name,city,address,latitude,longitude,store_hours.timezone,store_hours.monday,store_hours.tuesday,store_hours.wednesday,store_hours.thursday,store_hours.friday,store_hours.saturday,store_hours.sunday,store_status,pickup_available,reservation_available,retailer_id,sku,quantity,offline_price\n' +
      ['DBC-VCSERUM-30,5,795', 'DBC-MICWTR-200,4,349']
        .map(
          (s) =>
            `st_shp,Shopify Test Store,Mumbai,"Hill Road, Mumbai 400050",19.05,72.83,Asia/Kolkata,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,ACTIVE,true,true,rtl_A,${s}`,
        )
        .join('\n');
    const { record } = await world.retailImports.create('brand_A', { type: 'SYSTEM', id: 't' }, 'stock.csv');
    await world.files.write(record.fileKey, Buffer.from(csv), 'text/csv');
    const report = await world.retailImports.process('brand_A', { type: 'SYSTEM', id: 't' }, record.importId);
    expect(report.record).toMatchObject({ rowsValid: 2, rowsInvalid: 0 });
    expect((await world.inventory.listByStore('brand_A', 'st_shp')).map((r) => r.variantId).sort()).toEqual([
      'var_7001',
      'var_7011',
    ]);

    // The archived mock catalogue's mappings are history: nothing "needs attention".
    const catalog = await as('admin_a').get('/api/products');
    expect(catalog.body.mapping_summary).toEqual({ auto_matched: 7, needs_attention: 0 });

    // Idempotent.
    const again = await as('admin_a').post('/api/integrations/shopify/sync');
    expect(again.body).toMatchObject({ product_count: 3, variant_count: 5 });
    expect((await world.products.listProducts('brand_A')).filter((p) => p.status !== 'ARCHIVED')).toHaveLength(3);
  });

  it('refreshes an expiring token before it runs out; a revoked token → reconnect', async () => {
    const fake = new FakeShopify();
    let now = NOW;
    const { world, connect, as } = shopifyWorld(fake, () => now);
    await connect();
    now = new Date(NOW.getTime() + 58 * 60_000); // 2 minutes before the 1-hour token expires
    expect((await as('admin_a').post('/api/integrations/shopify/sync')).status).toBe(200);
    const refresh = fake.seen.filter((s) => s.operation === 'TOKEN').at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'shprt_test_refresh_1',
      client_id: SHOPIFY_TEST_APP.apiKey,
    });
    expect(await world.shopifyStore.get('brand_A')).toMatchObject({
      accessToken: `shpua_test_access_2`,
      refreshToken: 'shprt_test_refresh_2',
    });
    expect(fake.seen.filter((s) => s.operation === 'QwikspotProducts').at(-1)!.accessToken).toBe('shpua_test_access_2');

    fake.revoked.add('shpua_test_access_2');
    const res = await as('admin_a').post('/api/integrations/shopify/sync');
    expect([res.status, res.body.error.code]).toEqual([409, 'SHOPIFY_RECONNECT_REQUIRED']);
    const status = (await as('admin_a').get('/api/brand/connections')).body.connections[0];
    expect(status).toMatchObject({ status: 'ERROR', last_error: { code: 'SHOPIFY_RECONNECT_REQUIRED' } });
  });
});

// ------------------------------------------------------------------------------------ webhooks

describe('POST /api/webhooks/shopify', () => {
  const send = (
    app: Parameters<typeof request>[0],
    topic: string,
    body: object,
    opts: { hmac?: string; id?: string; shop?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/api/webhooks/shopify')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', topic)
      .set('X-Shopify-Shop-Domain', opts.shop ?? TEST_SHOP)
      .set('X-Shopify-Event-Id', opts.id ?? `evt-${topic}-1`)
      .set('X-Shopify-Hmac-Sha256', opts.hmac ?? webhookHmac(raw))
      .send(raw);
  };
  const order = (attrs: { name: string; value: string }[] = [], id = 6100000000001) => ({
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    note_attributes: attrs,
    line_items: [{ variant_id: 7001, sku: 'DBC-VCSERUM-30', quantity: 1, price: '795.00' }],
  });
  const ordersOf = (world: ReturnType<typeof buildTestWorld>) =>
    world.events.events.filter((e) => e.eventType === 'ORDER_CREATED');

  it('a bad or missing signature → 401 and nothing is processed', async () => {
    const { world } = await connected();
    const bad = await send(world.app, 'orders/create', order(), { hmac: webhookHmac('{"other":true}') });
    expect(bad.status).toBe(401);
    const none = await request(world.app)
      .post('/api/webhooks/shopify')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', 'orders/create')
      .set('X-Shopify-Shop-Domain', TEST_SHOP)
      .send(JSON.stringify(order()));
    expect(none.status).toBe(401);
    expect(ordersOf(world)).toHaveLength(0);
    expect(world.receipts).toBeDefined();
  });

  it('orders/create with a valid qs_ref is attributed (ONLINE outcome); the same event twice records one order', async () => {
    const { world } = await connected();
    const text = await world.conversation.attribution.decorate(
      'brand_A',
      'Order here: https://aquaskin.example/products/prd_9001',
      { intentId: null, conversationId: 'conv_shopify_1', recommendationId: null },
    );
    const ref = /qs_ref=([0-9A-Z]{26})/.exec(text)![1]!;
    const res = await send(world.app, 'orders/create', order([{ name: 'qs_ref', value: ref }]));
    expect(res.status).toBe(200);
    expect(ordersOf(world)).toEqual([
      expect.objectContaining({
        source: 'SHOPIFY',
        entityReference: 'gid://shopify/Order/6100000000001',
        payload: expect.objectContaining({
          variant_id: 'var_7001',
          attributed_by: 'QS_REF',
          journey_key: 'conv:conv_shopify_1',
        }),
      }),
    ]);
    expect(world.outcomes.outcomes).toEqual([
      expect.objectContaining({ purchaseType: 'ONLINE', orderReference: 'gid://shopify/Order/6100000000001' }),
    ]);
    const dup = await send(world.app, 'orders/create', order([{ name: 'qs_ref', value: ref }]));
    expect(dup.status).toBe(200);
    expect(ordersOf(world)).toHaveLength(1);
    expect(world.outcomes.outcomes).toHaveLength(1);
  });

  it('an invalid or missing qs_ref still records the order, unattributed', async () => {
    const { world } = await connected();
    await send(world.app, 'orders/create', order([{ name: 'qs_ref', value: 'NOT-A-REAL-REF' }], 1), { id: 'e1' });
    await send(world.app, 'orders/create', order([], 2), { id: 'e2' });
    expect(ordersOf(world).map((e) => [e.entityReference, e.payload.attributed_by])).toEqual([
      ['gid://shopify/Order/1', null],
      ['gid://shopify/Order/2', null],
    ]);
    expect(world.audit.brandEvents.filter((e) => e.action === 'ORDER_RECORDED').map((e) => e.reasonCode)).toEqual([
      'UNATTRIBUTED',
      'UNATTRIBUTED',
    ]);
    expect(world.outcomes.outcomes).toHaveLength(0);
  });

  it('an unknown shop is acknowledged and ignored', async () => {
    const { world } = await connected();
    const res = await send(world.app, 'orders/create', order(), { shop: 'stranger.myshopify.com' });
    expect(res.status).toBe(200);
    expect(ordersOf(world)).toHaveLength(0);
  });

  it('app/uninstalled deletes the token and marks the connection DISCONNECTED', async () => {
    const { world, as } = await connected();
    const res = await send(world.app, 'app/uninstalled', { id: 1, domain: TEST_SHOP });
    expect(res.status).toBe(200);
    expect(world.shopifyStore.secrets.size).toBe(0);
    expect(await world.shopifyStore.brandForShop(TEST_SHOP)).toBeNull();
    expect((await as('admin_a').get('/api/brand/connections')).body.connections[0]).toMatchObject({
      status: 'DISCONNECTED',
    });
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'SHOPIFY_UNINSTALLED', actorType: 'SYSTEM' });
    const sync = await as('admin_a').post('/api/integrations/shopify/sync');
    expect(sync.body.error.code).toBe('SHOPIFY_NOT_CONNECTED');
  });
});

describe('Shopify cart URL for BUY_ONLINE and get_product_context', () => {
  it('shopifyVariantNumber extracts numeric ID from externalId, attributes or shopifyVariantId', () => {
    expect(shopifyVariantNumber({ externalId: 'gid://shopify/ProductVariant/7001' })).toBe('7001');
    expect(shopifyVariantNumber({ attributes: { shopify_variant_id: '7002' } })).toBe('7002');
    expect(shopifyVariantNumber({ shopifyVariantId: 'gid://shopify/ProductVariant/7003' })).toBe('7003');
    expect(shopifyVariantNumber({ shopifyVariantId: '7004' })).toBe('7004');
    expect(shopifyVariantNumber('7005')).toBe('7005');
    expect(shopifyVariantNumber(null)).toBeNull();
    expect(shopifyVariantNumber({})).toBeNull();
    expect(shopifyVariantNumber({ shopifyVariantId: 'invalid' })).toBeNull();
  });

  it('BUY_ONLINE with selected Shopify variant returns https://{shopDomain}/cart/{variantId}:1', async () => {
    const { world } = await connected();
    const product = (await world.products.listProducts('brand_A'))[0]!;
    const variant = (await world.products.listVariants('brand_A')).find((v) => v.productId === product.productId)!;

    const tools = createToolHandlers({
      brands: world.brands,
      products: world.products,
      stores: world.stores,
      inventory: world.inventory,
      customers: world.customers,
      connections: world.connections,
      conversations: world.conversations,
      intents: world.intents,
      reservations: world.conversation.reservations,
      events: world.conversation.recorder,
      now: () => NOW,
    });

    const res = await (tools as any).get_product_context(
      { variant_id: variant.variantId },
      { brandId: 'brand_A', customerId: 'cust_1', conversationId: 'conv_1', intentId: null, recommendationId: 'rec_1' },
    );

    expect(res.status).toBe('EXECUTED');
    const output = res.output as any;
    expect(output.status).toBe('FOUND');
    expect(output.product.online_url).toBe(`https://${TEST_SHOP}/cart/7001:1`);
  });

  it('If Shopify connection is missing/disconnected or variant id is missing, fallback remains existing onlineProductUrl behavior', async () => {
    const { world } = await connected();

    await world.connections.put({
      connectionId: SHOPIFY_CONNECTION_ID,
      brandId: 'brand_A',
      provider: 'SHOPIFY',
      source: 'SHOPIFY',
      status: 'DISCONNECTED',
      connectedAt: NOW.toISOString(),
      lastSyncAt: NOW.toISOString(),
      lastError: null,
      productCount: 0,
      variantCount: 0,
    });

    const product = (await world.products.listProducts('brand_A'))[0]!;
    const variant = (await world.products.listVariants('brand_A')).find((v) => v.productId === product.productId)!;

    const tools = createToolHandlers({
      brands: world.brands,
      products: world.products,
      stores: world.stores,
      inventory: world.inventory,
      customers: world.customers,
      connections: world.connections,
      conversations: world.conversations,
      intents: world.intents,
      reservations: world.conversation.reservations,
      events: world.conversation.recorder,
      now: () => NOW,
    });

    const res = await (tools as any).get_product_context(
      { variant_id: variant.variantId },
      { brandId: 'brand_A', customerId: 'cust_1', conversationId: 'conv_1', intentId: null, recommendationId: 'rec_1' },
    );

    expect(res.status).toBe('EXECUTED');
    const output = res.output as any;
    expect(output.status).toBe('FOUND');
    expect(output.product.online_url).toBe(`https://aquaskin.example/products/${product.productId}`);
  });
});

// ------------------------------------------------------------------------------------ L2-Shopify follow-ups

const SCOPE = {
  brandId: 'brand_A',
  customerId: 'cust_1',
  conversationId: 'conv_1',
  intentId: null,
  recommendationId: 'rec_1',
};
const V7001 = 'gid://shopify/ProductVariant/7001';

type World = ReturnType<typeof buildTestWorld>;

function toolsFor(world: World, onlineStock?: { canBuyOnline: (b: string, v: string) => Promise<boolean | null> }) {
  return createToolHandlers({
    brands: world.brands,
    products: world.products,
    stores: world.stores,
    inventory: world.inventory,
    customers: world.customers,
    connections: world.connections,
    conversations: world.conversations,
    intents: world.intents,
    reservations: world.conversation.reservations,
    events: world.conversation.recorder,
    now: () => NOW,
    onlineStock,
  }) as any;
}

/** The real provider and HTTP adapter against the fake store, with the brand's stored token. */
const liveStock = (world: World, fake: FakeShopify) => {
  const provider = new ShopifyCommerceProvider(
    new ShopifyHttpAdminApi(SHOPIFY_TEST_APP, { fetch: fake.fetch, sleep: async () => {} }),
    TEST_SHOP,
    async () => (await world.shopifyStore.get('brand_A'))!.accessToken,
  );
  return new OnlineStockService({ resolver: { forBrand: async () => provider }, now: () => NOW });
};

const sendWebhook = (world: World, topic: string, body: object, id: string) => {
  const raw = JSON.stringify(body);
  return request(world.app)
    .post('/api/webhooks/shopify')
    .set('Content-Type', 'application/json')
    .set('X-Shopify-Topic', topic)
    .set('X-Shopify-Shop-Domain', TEST_SHOP)
    .set('X-Shopify-Event-Id', id)
    .set('X-Shopify-Hmac-Sha256', webhookHmac(raw))
    .send(raw);
};

const webhookOrder = (id: number, attrs: { name: string; value: string }[] = [], cancelledAt?: string) => ({
  id,
  admin_graphql_api_id: `gid://shopify/Order/${id}`,
  note_attributes: attrs,
  ...(cancelledAt ? { cancelled_at: cancelledAt } : {}),
  line_items: [{ variant_id: 7001, sku: 'DBC-VCSERUM-30', quantity: 1, price: '795.00' }],
});

/** An order as the GraphQL Admin API returns it (QwikspotOrders). */
const orderNode = (id: number, opts: { qsRef?: string; cancelledAt?: string } = {}) => ({
  id: `gid://shopify/Order/${id}`,
  createdAt: '2026-10-06T10:00:00Z',
  cancelledAt: opts.cancelledAt ?? null,
  customAttributes: opts.qsRef ? [{ key: 'qs_ref', value: opts.qsRef }] : [],
  customer: null,
  totalPriceSet: { shopMoney: { amount: '795.00', currencyCode: 'INR' } },
  lineItems: {
    nodes: [
      {
        sku: 'DBC-VCSERUM-30',
        quantity: 1,
        variant: { id: V7001, sku: 'DBC-VCSERUM-30' },
        originalUnitPriceSet: { shopMoney: { amount: '795.00' } },
      },
    ],
  },
});

const eventsOf = (world: World, type: string) => world.events.events.filter((e) => e.eventType === type);

/** A fresh qs_ref in a chat message's Shopify cart link, as a customer would receive it. */
async function cartRef(world: World, conversationId = 'conv_cart_1') {
  const url = (await toolsFor(world).get_product_context({ variant_id: 'var_7001' }, SCOPE)).output.product.online_url;
  const text = await world.conversation.attribution.decorate('brand_A', `You can order it online here: ${url}`, {
    intentId: null,
    conversationId,
    recommendationId: null,
  });
  return { url, text, ref: /attributes%5Bqs_ref%5D=([0-9A-Z]{26})/.exec(text)?.[1] ?? null };
}

describe('qs_ref on the connected store’s cart links', () => {
  const REF = '0123456789ABCDEFGHJKMNPQRS';

  it('is added as the cart attribute attributes[qs_ref], replacing an old one and keeping other parameters', () => {
    const shop = 'https://s.myshopify.com/cart/7001:1';
    expect(withShopifyCartAttribute(shop, REF)).toBe(`${shop}?attributes%5Bqs_ref%5D=${REF}`);
    const again = withShopifyCartAttribute(`${shop}?attributes[qs_ref]=OLD&discount=X#top`, REF);
    expect(again).toBe(`${shop}?discount=X&attributes%5Bqs_ref%5D=${REF}#top`);
    expect(new URL(again).searchParams.get('attributes[qs_ref]')).toBe(REF);
  });

  it('decorates cart links with the attribute and storefront links with the query parameter, nothing else', () => {
    const targets = { storefrontPrefix: 'https://aquaskin.example/products/', shopifyShop: TEST_SHOP };
    const text = [
      `cart https://${TEST_SHOP}/cart/7001:1`,
      'page https://aquaskin.example/products/prd_9001',
      'other https://other-shop.myshopify.com/cart/7001:1',
      `admin https://${TEST_SHOP}/admin`,
    ].join('\n');
    expect(decorateOnlineLinks(text, targets, REF).split('\n')).toEqual([
      `cart https://${TEST_SHOP}/cart/7001:1?attributes%5Bqs_ref%5D=${REF}`,
      `page https://aquaskin.example/products/prd_9001?qs_ref=${REF}`,
      'other https://other-shop.myshopify.com/cart/7001:1',
      `admin https://${TEST_SHOP}/admin`,
    ]);
    expect(linksToOnlineStore('see https://other-shop.myshopify.com/cart/1:1', targets)).toBe(false);
    expect(linksToOnlineStore(text, { storefrontPrefix: null, shopifyShop: null })).toBe(false);
  });

  it('chat cart link → Shopify order with that cart attribute → attributed ONLINE outcome', async () => {
    const { world } = await connected();
    const { url, text, ref } = await cartRef(world);
    expect(url).toBe(`https://${TEST_SHOP}/cart/7001:1`);
    expect(ref).not.toBeNull();
    expect(text).not.toContain('?qs_ref=');
    expect(world.attributionRefs.refs).toHaveLength(1);

    const res = await sendWebhook(world, 'orders/create', webhookOrder(61, [{ name: 'qs_ref', value: ref! }]), 'c1');
    expect(res.status).toBe(200);
    expect(eventsOf(world, 'ORDER_CREATED')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ attributed_by: 'QS_REF', journey_key: 'conv:conv_cart_1' }),
      }),
    ]);
    expect(world.outcomes.outcomes).toEqual([
      expect.objectContaining({ purchaseType: 'ONLINE', orderReference: 'gid://shopify/Order/61' }),
    ]);
  });

  it('a disconnected store’s cart links are left alone (no ref is created)', async () => {
    const { world, as } = await connected();
    await as('admin_a').post('/api/integrations/shopify/disconnect');
    const text = `Order: https://${TEST_SHOP}/cart/7001:1`;
    expect(await world.conversation.attribution.decorate('brand_A', text, SCOPE)).toBe(text);
    expect(world.attributionRefs.refs).toHaveLength(0);
  });
});

describe('live online stock before "Buy online"', () => {
  it('a variant Shopify cannot sell online gets no online link at all — not even the storefront page', async () => {
    const { world, fake } = await connected();
    fake.availableForSale.set(V7001, false);
    const out = (await toolsFor(world, liveStock(world, fake)).get_product_context({ variant_id: 'var_7001' }, SCOPE))
      .output;
    expect(out.status).toBe('FOUND');
    expect(out.product.online_url).toBeNull();
  });

  it('an available variant gets the cart link; one answer serves the turn (cached), the token stays server-side', async () => {
    const { world, fake } = await connected();
    const tools = toolsFor(world, liveStock(world, fake));
    for (let i = 0; i < 2; i++) {
      const out = (await tools.get_product_context({ variant_id: 'var_7001' }, SCOPE)).output;
      expect(out.product.online_url).toBe(`https://${TEST_SHOP}/cart/7001:1`);
    }
    const asked = fake.seen.filter((s) => s.operation === 'QwikspotOnlineAvailability');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.variables).toEqual({ id: V7001 });
  });

  it('when Shopify cannot be asked the link stays (checkout still refuses), and nothing is cached', async () => {
    const { world, fake } = await connected();
    fake.queue('QwikspotOnlineAvailability', { errors: [{ message: 'boom' }] }, 500);
    const stock = liveStock(world, fake);
    expect(await stock.canBuyOnline('brand_A', V7001)).toBeNull();
    expect(await stock.canBuyOnline('brand_A', V7001)).toBe(true);
    expect(fake.seen.filter((s) => s.operation === 'QwikspotOnlineAvailability')).toHaveLength(2);
  });

  it('the mock catalogue answers from its fixture inventory', async () => {
    const mock = new MockCommerceProvider();
    expect(await mock.getOnlineAvailability('gid://shopify/ProductVariant/2001')).toBe(true);
    expect(await mock.getOnlineAvailability('gid://shopify/ProductVariant/unknown')).toBeNull();
  });
});

describe('orders/cancelled', () => {
  it('cancels the attributed order’s Outcome once: it stays, marked, and leaves the insights', async () => {
    const { world } = await connected();
    const { ref } = await cartRef(world);
    await sendWebhook(world, 'orders/create', webhookOrder(62, [{ name: 'qs_ref', value: ref! }]), 'c2');
    const cancelledAt = '2026-10-07T07:00:00Z';
    const res = await sendWebhook(world, 'orders/cancelled', webhookOrder(62, [], cancelledAt), 'x2');
    expect(res.status).toBe(200);
    expect(world.outcomes.outcomes).toEqual([
      expect.objectContaining({ purchaseType: 'ONLINE', orderReference: 'gid://shopify/Order/62', cancelledAt }),
    ]);
    expect(eventsOf(world, 'ORDER_CANCELLED')).toEqual([
      expect.objectContaining({ source: 'SHOPIFY', entityReference: 'gid://shopify/Order/62', timestamp: cancelledAt }),
    ]);
    expect(world.audit.brandEvents.map((e) => e.action)).toEqual(
      expect.arrayContaining(['ORDER_CANCELLED', 'OUTCOME_CANCELLED']),
    );

    // Another delivery of the same cancellation changes nothing.
    await sendWebhook(world, 'orders/cancelled', webhookOrder(62, [], cancelledAt), 'x2-again');
    expect(eventsOf(world, 'ORDER_CANCELLED')).toHaveLength(1);
    expect(world.audit.brandEvents.filter((e) => e.action === 'OUTCOME_CANCELLED')).toHaveLength(1);

    const reader = new MemoryInsightsReader({
      intents: world.intents,
      conversations: world.conversations,
      recommendations: world.recommendations,
      events: world.events,
      reservations: world.reservations,
      outcomes: world.outcomes,
    });
    const { rows } = await reader.read('brand_A', {
      fromIso: '2026-10-01T00:00:00Z',
      toIso: '2026-10-31T00:00:00Z',
      includeHistory: true,
    });
    expect(rows.outcomes).toHaveLength(0);
  });

  it('a cancellation whose orders/create never arrived records the order too (unattributed, no Outcome)', async () => {
    const { world } = await connected();
    await sendWebhook(world, 'orders/cancelled', webhookOrder(63, [], '2026-10-07T07:00:00Z'), 'x3');
    expect(eventsOf(world, 'ORDER_CREATED').map((e) => e.entityReference)).toEqual(['gid://shopify/Order/63']);
    expect(eventsOf(world, 'ORDER_CANCELLED')).toHaveLength(1);
    expect(world.outcomes.outcomes).toHaveLength(0);
  });
});

describe('the order check (missed webhooks)', () => {
  it('records the last 7 days of orders the webhooks missed, once — the webhook arriving later is a duplicate', async () => {
    const { world, fake, as } = await connected();
    const { ref } = await cartRef(world);
    fake.orders.push(orderNode(71, { qsRef: ref! }), orderNode(72));

    const first = await as('admin_a').post('/api/integrations/shopify/orders/sync');
    expect([first.status, first.body]).toEqual([200, { checked: 2, recorded: 2, cancelled: 0 }]);
    const query = fake.seen.filter((s) => s.operation === 'QwikspotOrders').at(-1)!;
    expect(query.variables.query).toBe("created_at:>'2026-09-30T06:30:00.000Z'");
    expect(eventsOf(world, 'ORDER_CREATED').map((e) => [e.entityReference, e.payload.attributed_by])).toEqual([
      ['gid://shopify/Order/71', 'QS_REF'],
      ['gid://shopify/Order/72', null],
    ]);
    expect(world.outcomes.outcomes).toEqual([expect.objectContaining({ orderReference: 'gid://shopify/Order/71' })]);
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'SHOPIFY_ORDERS_CHECKED', actorId: 'admin_a' });

    const recorded = () => world.audit.brandEvents.filter((e) => e.action === 'ORDER_RECORDED').length;
    const before = recorded();
    const again = await as('admin_a').post('/api/integrations/shopify/orders/sync');
    expect(again.body).toEqual({ checked: 2, recorded: 0, cancelled: 0 });
    await sendWebhook(world, 'orders/create', webhookOrder(71, [{ name: 'qs_ref', value: ref! }]), 'late-71');
    expect(recorded()).toBe(before);
  });

  it('records cancellations it finds, once', async () => {
    const { world, fake, as } = await connected();
    fake.orders.push(orderNode(73, { cancelledAt: '2026-10-06T12:00:00Z' }));
    const first = await as('admin_a').post('/api/integrations/shopify/orders/sync');
    expect(first.body).toEqual({ checked: 1, recorded: 1, cancelled: 1 });
    const again = await as('admin_a').post('/api/integrations/shopify/orders/sync');
    expect(again.body).toEqual({ checked: 1, recorded: 0, cancelled: 0 });
    expect(eventsOf(world, 'ORDER_CANCELLED')).toHaveLength(1);
  });

  it('"Sync products" also runs it and brings an older connection’s webhooks up to date — same response shape', async () => {
    const { world, fake, connect, as } = shopifyWorld();
    await connect();
    fake.webhooks.splice(
      0,
      fake.webhooks.length,
      ...fake.webhooks.filter((w) => /ORDERS_CREATE|APP_UNINSTALLED/.test(w.topic)),
    );
    fake.orders.push(orderNode(74));
    const res = await as('admin_a').post('/api/integrations/shopify/sync');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('checked');
    expect(fake.webhooks.map((w) => w.topic).sort()).toEqual([
      'APP_UNINSTALLED',
      'ORDERS_CANCELLED',
      'ORDERS_CREATE',
      'PRODUCTS_CREATE',
      'PRODUCTS_DELETE',
      'PRODUCTS_UPDATE',
    ]);
    expect(eventsOf(world, 'ORDER_CREATED').map((e) => e.entityReference)).toEqual(['gid://shopify/Order/74']);
  });

  it('only the Brand Admin, only in Shopify mode, only with a connected store', async () => {
    const { as } = shopifyWorld();
    const none = await as('admin_a').post('/api/integrations/shopify/orders/sync');
    expect([none.status, none.body.error.code]).toEqual([409, 'SHOPIFY_NOT_CONNECTED']);
    expect((await as('radmin_A').post('/api/integrations/shopify/orders/sync')).status).toBe(403);
    const mock = buildTestWorld();
    const off = await request(mock.app)
      .post('/api/integrations/shopify/orders/sync')
      .set('Authorization', bearer('admin_a'))
      .send({});
    expect([off.status, off.body.error.code]).toEqual([409, 'SHOPIFY_NOT_CONFIGURED']);
  });
});

describe('products/* webhooks keep the catalogue current', () => {
  it('a product change queues a background sync that picks it up', async () => {
    const { world, fake } = await connected();
    const page = JSON.parse(
      readFileSync(new URL('./fixtures/shopify/products-page-1.json', import.meta.url), 'utf8'),
    ) as { data: { products: { nodes: { title: string }[] } } };
    page.data.products.nodes[0]!.title = 'Vitamin C Glow Serum (new formula)';
    fake.queue('QwikspotProducts', page);

    const res = await sendWebhook(world, 'products/update', { id: 9001 }, 'p1');
    expect(res.status).toBe(200);
    await world.catalogRefresh.idle('brand_A');
    const product = (await world.products.listProducts('brand_A')).find((p) => p.productId === 'prd_9001')!;
    expect(product.title).toBe('Vitamin C Glow Serum (new formula)');
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'CATALOG_SYNCED', actorId: 'shopify-webhook' });
  });

  it('a burst coalesces into the running sync plus one; a failed sync is logged, never thrown', async () => {
    let release!: () => void;
    const runs: string[] = [];
    const warnings: string[] = [];
    const refresh = new ShopifyCatalogRefresh({
      sync: {
        sync: async (brandId) => {
          runs.push(brandId);
          if (runs.length === 1) await new Promise<void>((r) => (release = r));
          if (runs.length === 2) throw new Error('shopify down');
          return {} as never;
        },
      },
      logger: { warn: (m: string) => void warnings.push(m) } as never,
    });
    const first = refresh.request('brand_A');
    const others = [refresh.request('brand_A'), refresh.request('brand_A'), refresh.request('brand_A')];
    release();
    await Promise.all([first, ...others]);
    expect(runs).toEqual(['brand_A', 'brand_A']);
    expect(warnings).toEqual(['shopify.catalog_refresh_failed']);
    await refresh.request('brand_A');
    expect(runs).toHaveLength(3);
  });
});
