import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestWorld } from './helpers.js';

type App = Parameters<typeof request>[0];
const as = (app: App, userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer(userId)).send(body),
  put: (path: string, body: Buffer) =>
    request(app).put(path).set('Authorization', bearer(userId)).set('Content-Type', 'text/csv').send(body),
});

const DEMO_CSV = readFileSync(new URL('../fixtures/retail/demo-retail.csv', import.meta.url));

/** The Brand Console flow: create import → PUT the file → process. */
async function uploadAndProcess(app: App, userId: string, content: Buffer) {
  const created = await as(app, userId).post('/api/brand/retail-imports', { file_name: 'stock.csv' });
  expect(created.status).toBe(201);
  const put = await as(app, userId).put(created.body.upload.url, content);
  expect(put.status).toBe(200);
  return as(app, userId).post(`/api/brand/retail-imports/${created.body.import.import_id}/process`);
}

function demoWorld() {
  const world = buildTestWorld();
  world.retailers.retailers.push(
    { brandId: 'brand_A', retailerId: 'rtl_north', name: 'North Retail', status: 'ACTIVE' },
    { brandId: 'brand_A', retailerId: 'rtl_pune', name: 'Pune Retail', status: 'ACTIVE' },
  );
  return world;
}

describe('catalogue routes (BRAND_ADMIN only)', () => {
  it('sync → connection status → products with variants and mapping status', async () => {
    const { app } = buildTestWorld();
    const admin = as(app, 'admin_a');
    expect((await admin.get('/api/brand/connections')).body).toEqual({ connections: [] });
    expect((await admin.get('/api/products')).body.products).toEqual([]);

    const sync = await admin.post('/api/integrations/shopify/sync');
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({
      connection_id: 'SHOPIFY',
      provider: 'SHOPIFY',
      source: 'MOCK',
      status: 'CONNECTED',
      product_count: 10,
      variant_count: 18,
      last_error: null,
    });
    expect(sync.body.last_sync_at).toMatch(/^\d{4}-/);

    const connections = await admin.get('/api/brand/connections');
    expect(connections.body.connections).toHaveLength(1);
    expect(JSON.stringify(connections.body)).not.toMatch(/credential_reference|token|secret/i);

    const products = await admin.get('/api/products');
    expect(products.body.products).toHaveLength(10);
    const serum = products.body.products.find((p: { title: string }) => p.title === 'Vitamin C Glow Serum');
    expect(serum.tags).toContain('serum');
    expect(
      serum.variants.map((v: { sku: string; mapping_status: string; price: number }) => [
        v.sku,
        v.mapping_status,
        v.price,
      ]),
    ).toEqual([
      ['DBC-VCSERUM-30', 'AUTO_MATCHED', 795],
      ['DBC-VCSERUM-50', 'AUTO_MATCHED', 1195],
    ]);
    expect(products.body.mapping_summary).toEqual({ auto_matched: 18, needs_attention: 0 });
  });

  it('a brand never sees another brand’s catalogue', async () => {
    const { app } = buildTestWorld();
    await as(app, 'admin_a').post('/api/integrations/shopify/sync');
    expect((await as(app, 'admin_b').get('/api/products')).body.products).toEqual([]);
    expect((await as(app, 'admin_b').get('/api/brand/connections')).body.connections).toEqual([]);
  });
});

describe('retail import routes (upload → process → report)', () => {
  it('imports the demo CSV through the upload flow; the report and history show the real row errors', async () => {
    const world = demoWorld();
    const admin = as(world.app, 'admin_a');
    await admin.post('/api/integrations/shopify/sync');

    const processed = await uploadAndProcess(world.app, 'admin_a', DEMO_CSV);
    expect(processed.status).toBe(200);
    expect(processed.body).toMatchObject({
      status: 'COMPLETED',
      rows_processed: 36,
      rows_valid: 33,
      rows_invalid: 3,
      mappings_failed: 1,
    });
    expect(processed.body.row_errors.map((e: { code: string }) => e.code)).toEqual([
      'INVALID_QUANTITY',
      'UNKNOWN_SKU',
      'INVALID_PRICE',
    ]);

    const history = await admin.get('/api/brand/retail-imports');
    expect(history.body.imports).toHaveLength(1);
    const report = await admin.get(`/api/brand/retail-imports/${processed.body.import_id}`);
    expect(report.body.row_errors).toHaveLength(3);

    // Brand Console store list: per-store SKU count and last stock update.
    const stores = await admin.get('/api/brand/stores');
    const bandra = stores.body.stores.find((s: { store_id: string }) => s.store_id === 'st_north_1');
    expect(bandra).toMatchObject({ retailer_id: 'rtl_north', retail_admin_user_id: null, sku_count: 10 });
    expect(bandra.stock_updated_at).toMatch(/^\d{4}-/);

    // The unmapped retail SKU stays visible in the catalogue view.
    const products = await admin.get('/api/products');
    expect(products.body.retail_mappings_needing_attention).toEqual([
      expect.objectContaining({ source_identifier: 'DBC-LIPBALM-10', mapping_status: 'UNMAPPED' }),
    ]);
    expect(products.body.mapping_summary.needs_attention).toBe(1);
  });

  it('validates input and refuses to process twice or before upload', async () => {
    const { app } = buildTestWorld();
    const admin = as(app, 'admin_a');
    expect((await admin.post('/api/brand/retail-imports', { file_name: 'stock.xlsx' })).status).toBe(400);
    const created = await admin.post('/api/brand/retail-imports', { file_name: 'stock.csv' });
    const processPath = `/api/brand/retail-imports/${created.body.import.import_id}/process`;
    expect((await admin.post(processPath)).body.error.code).toBe('FILE_NOT_UPLOADED');
    await admin.put(created.body.upload.url, Buffer.from('store_id\n'));
    expect((await admin.post(processPath)).body.status).toBe('FAILED'); // missing columns
    expect((await admin.post(processPath)).body.error.code).toBe('IMPORT_ALREADY_PROCESSED');
    expect((await admin.get('/api/brand/retail-imports/imp_nope')).status).toBe(404);
  });

  it('local upload target: only the importing brand can upload; unknown uploads → 404; empty → 400', async () => {
    const { app } = buildTestWorld();
    const created = await as(app, 'admin_a').post('/api/brand/retail-imports', { file_name: 'stock.csv' });
    const url = created.body.upload.url as string;
    expect(url).toMatch(/^\/api\/local-files\/uploads\/[0-9a-f-]{36}$/);

    expect((await as(app, 'admin_b').put(url, Buffer.from('x'))).status).toBe(404);
    expect((await as(app, 'radmin_A').put(url, Buffer.from('x'))).status).toBe(403);
    expect((await as(app, 'admin_a').put('/api/local-files/uploads/not-an-id', Buffer.from('x'))).status).toBe(404);
    expect((await as(app, 'admin_a').put(url, Buffer.alloc(0))).status).toBe(400);
    expect((await as(app, 'admin_a').put(url, Buffer.from('store_id\n'))).status).toBe(200);
    // One upload per target.
    expect((await as(app, 'admin_a').put(url, Buffer.from('store_id\n'))).status).toBe(404);
  });

  it('the local upload endpoint does not exist when no local receiver is wired (gcp)', async () => {
    const { app } = buildTestWorld({ localUploads: false });
    const res = await as(app, 'admin_a').put(
      '/api/local-files/uploads/00000000-0000-0000-0000-000000000000',
      Buffer.from('x'),
    );
    expect(res.status).toBe(404);
  });
});

describe('authorization on the M3 routes', () => {
  const brandRoutes: [string, string][] = [
    ['POST', '/api/integrations/shopify/sync'],
    ['GET', '/api/products'],
    ['GET', '/api/brand/connections'],
    ['GET', '/api/brand/retail-imports'],
    ['POST', '/api/brand/retail-imports'],
    ['POST', '/api/brand/retail-imports/imp_0000000000000000/process'],
  ];

  it.each(brandRoutes)('%s %s: RETAIL_ADMIN → 403, PLATFORM_ADMIN → 403', async (method, path) => {
    const { app } = buildTestWorld();
    for (const userId of ['radmin_A', 'platform']) {
      const res =
        method === 'GET' ? await as(app, userId).get(path) : await as(app, userId).post(path, { file_name: 'x.csv' });
      expect(res.status, `${userId} ${path}`).toBe(403);
    }
  });

  it('Retail Admin stock: own store only; Store B of the SAME retailer → 404; other scopes → 403', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', { type: 'SYSTEM', id: 't' });
    const csv = [
      'store_id,store_name,city,address,latitude,longitude,store_hours.timezone,store_hours.monday,store_hours.tuesday,store_hours.wednesday,store_hours.thursday,store_hours.friday,store_hours.saturday,store_hours.sunday,store_status,sku,quantity,offline_price',
      'store_A,Store A,Mumbai,A street,19.05,72.82,Asia/Kolkata,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,,ACTIVE,DBC-VCSERUM-30,3,795',
      'store_B,Store B,Mumbai,B street,19.13,72.83,Asia/Kolkata,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,10:00-21:00,,ACTIVE,DBC-VCSERUM-30,5,795',
    ].join('\n');
    await uploadAndProcess(world.app, 'admin_a', Buffer.from(csv));

    const own = await as(world.app, 'radmin_A').get('/api/retail/stores/store_A/inventory');
    expect(own.status).toBe(200);
    expect(own.body.items).toEqual([
      expect.objectContaining({
        sku: 'DBC-VCSERUM-30',
        product_title: 'Vitamin C Glow Serum',
        variant_title: '30 ml',
        quantity: 3,
        reserved_quantity: 0,
        available_quantity: 3,
        availability_status: 'LOW_STOCK',
      }),
    ]);

    // store_B belongs to the same retailer (rtl_A) as store_A.
    const storeB = await as(world.app, 'radmin_A').get('/api/retail/stores/store_B/inventory');
    expect(storeB.status).toBe(404);
    expect(JSON.stringify(storeB.body)).not.toContain('DBC-VCSERUM-30');
    expect((await as(world.app, 'radmin_B').get('/api/retail/stores/store_B/inventory')).body.items[0].quantity).toBe(
      5,
    );
    expect((await as(world.app, 'radmin_b').get('/api/retail/stores/store_A/inventory')).status).toBe(404);
    expect((await as(world.app, 'admin_a').get('/api/retail/stores/store_A/inventory')).status).toBe(403);
    expect((await as(world.app, 'platform').get('/api/retail/stores/store_A/inventory')).status).toBe(403);
  });

  it('an empty store shows an empty stock list, not an error', async () => {
    const { app } = buildTestWorld();
    const res = await as(app, 'radmin_A').get('/api/retail/stores/store_A/inventory');
    expect(res.body).toEqual({ store_id: 'store_A', items: [] });
  });
});
