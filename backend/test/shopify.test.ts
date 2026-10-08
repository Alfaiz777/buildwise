/**
 * L2-Shopify (docs/06 §2, §8, §8.1, §9, §17.1): OAuth connect / callback / disconnect,
 * the GraphQL provider and sync, token refresh, and the orders/create and app/uninstalled
 * webhooks — through the real routes and the real ShopifyHttpAdminApi against FakeShopify
 * (recorded fixtures; no network).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ShopifyHttpAdminApi } from '../src/adapters/commerce/shopifyAdminApi.js';
import { ShopifyCommerceProvider } from '../src/adapters/commerce/shopifyCommerceProvider.js';
import { MockCommerceProvider } from '../src/adapters/commerce/mockCommerceProvider.js';
import { CommerceSyncService } from '../src/application/commerceSyncService.js';
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
import { FakeShopify, SHOPIFY_TEST_APP, signedCallback, TEST_SHOP, webhookHmac } from './shopifyFakes.js';

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
    expect(fake.webhooks.map((w) => [w.topic, w.uri])).toEqual([
      ['ORDERS_CREATE', 'https://tunnel.example.test/api/webhooks/shopify'],
      ['APP_UNINSTALLED', 'https://tunnel.example.test/api/webhooks/shopify'],
    ]);
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
    expect(fake.webhooks).toHaveLength(2);
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
