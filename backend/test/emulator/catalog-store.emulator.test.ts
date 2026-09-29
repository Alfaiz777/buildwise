/**
 * M3 local end-to-end on the Firebase Auth + Firestore emulators, with the REAL
 * composition root (local profile): MockCommerceProvider, LocalFileStorageProvider,
 * CsvRetailFileParser and the Firestore repositories — no fakes.
 *
 *   seed brand + retailers → BRAND_ADMIN syncs the catalogue → uploads the demo CSV
 *   through the local upload target → processes it → Brand Console data is right →
 *   each RETAIL_ADMIN sees only its own store's stock.
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
import { silentLogger } from '../../src/lib/logger.js';

const PROJECT = 'demo-buildwise';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const BRAND = 'brd_m3';
const PASSWORD = 'password-123';
let dataDir = '';
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof initFirebase>['db'];
let auth: ReturnType<typeof initFirebase>['auth'];
const tokens: Record<string, string> = {};

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

const call = (token: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', `Bearer ${token}`).send(body),
  put: (path: string, body: Buffer) =>
    request(app).put(path).set('Authorization', `Bearer ${token}`).set('Content-Type', 'text/csv').send(body),
});

async function importDemoCsv(): Promise<request.Response> {
  const admin = call(tokens.brandAdmin!);
  const created = await admin.post('/api/brand/retail-imports', { file_name: 'demo-retail.csv' });
  expect(created.status).toBe(201);
  const csv = await readFile(new URL('../../fixtures/retail/demo-retail.csv', import.meta.url));
  expect((await admin.put(created.body.upload.url, csv)).status).toBe(200);
  return admin.post(`/api/brand/retail-imports/${created.body.import.import_id}/process`);
}

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'buildwise-m3-'));

  const config = loadConfig({
    ...process.env,
    BUILDWISE_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
  });
  const container = buildContainer(config, silentLogger);
  app = createApp(container.appDeps);
  ({ auth, db } = initFirebase(PROJECT, config.emulators));

  // Seeded tenant: brand + its Brand Admin + two retailers (stores come from the import).
  const { uid } = await auth.createUser({ email: 'admin@m3.test', password: PASSWORD });
  await db
    .doc(`brands/${BRAND}`)
    .set({ brand_id: BRAND, name: 'M3 Beauty', status: 'ACTIVE', settings: {}, brand_admin_user_id: uid });
  await db.doc(`users/${uid}`).set({
    user_id: uid,
    role: 'BRAND_ADMIN',
    brand_id: BRAND,
    retailer_id: null,
    store_id: null,
    email: 'admin@m3.test',
    status: 'ACTIVE',
  });
  for (const [id, name] of [
    ['rtl_north', 'North Retail'],
    ['rtl_pune', 'Pune Retail'],
  ]) {
    await db.doc(`brands/${BRAND}/retailers/${id}`).set({ retailer_id: id, brand_id: BRAND, name, status: 'ACTIVE' });
  }
  tokens.brandAdmin = await signIn('admin@m3.test');
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('M3 local E2E: catalogue sync → retail CSV import → store stock', () => {
  it('BRAND_ADMIN syncs the catalogue into Firestore (idempotently)', async () => {
    const admin = call(tokens.brandAdmin!);
    const first = await admin.post('/api/integrations/shopify/sync');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'CONNECTED', source: 'MOCK', product_count: 10, variant_count: 18 });
    await admin.post('/api/integrations/shopify/sync');

    expect((await db.collection(`brands/${BRAND}/products`).get()).size).toBe(10);
    expect((await db.collection(`brands/${BRAND}/productVariants`).get()).size).toBe(18);
    expect((await db.collection(`brands/${BRAND}/productMappings`).get()).size).toBe(18);
    const variant = await db.doc(`brands/${BRAND}/productVariants/var_2001`).get();
    expect(variant.data()).toMatchObject({ sku: 'DBC-VCSERUM-30', canonical_sku: 'DBC-VCSERUM-30', price: 795 });
    const connection = await db.doc(`brands/${BRAND}/connections/SHOPIFY`).get();
    expect(connection.data()).toMatchObject({ provider: 'SHOPIFY', status: 'CONNECTED', credential_reference: null });
  });

  it('BRAND_ADMIN uploads and processes the demo CSV; the report shows the real row errors', async () => {
    const processed = await importDemoCsv();
    expect(processed.status).toBe(200);
    expect(processed.body).toMatchObject({
      status: 'COMPLETED',
      rows_processed: 36,
      rows_valid: 33,
      rows_invalid: 3,
      mappings_failed: 1,
    });
    expect(processed.body.row_errors.map((e: { code: string; line: number }) => [e.line, e.code])).toEqual([
      [12, 'INVALID_QUANTITY'],
      [23, 'UNKNOWN_SKU'],
      [37, 'INVALID_PRICE'],
    ]);

    const history = await call(tokens.brandAdmin!).get('/api/brand/retail-imports');
    expect(history.body.imports[0]).toMatchObject({ status: 'COMPLETED', file_name: 'demo-retail.csv' });
  });

  it('Brand Console data: stores with retailer + stock summary, inventory, unmapped SKU visible', async () => {
    const admin = call(tokens.brandAdmin!);
    const stores = await admin.get('/api/brand/stores');
    const byId = Object.fromEntries(
      stores.body.stores.map((s: { store_id: string; retailer_id: string; sku_count: number }) => [
        s.store_id,
        [s.retailer_id, s.sku_count],
      ]),
    );
    expect(byId).toEqual({
      st_north_1: ['rtl_north', 10],
      st_north_2: ['rtl_north', 10],
      st_north_3: ['rtl_north', 7],
      st_pune_1: ['rtl_pune', 6],
    });

    const inventory = await db.doc(`brands/${BRAND}/retailInventory/st_north_2__DBC-VCSERUM-30`).get();
    expect(inventory.data()).toMatchObject({ quantity: 5, reserved_quantity: 0, availability_status: 'IN_STOCK' });

    const products = await admin.get('/api/products');
    expect(products.body.retail_mappings_needing_attention).toEqual([
      expect.objectContaining({ source_identifier: 'DBC-LIPBALM-10', mapping_status: 'UNMAPPED' }),
    ]);
  });

  it('re-import overwrites quantity but never reserved_quantity (real Firestore writes)', async () => {
    const ref = db.doc(`brands/${BRAND}/retailInventory/st_north_2__DBC-VCSERUM-30`);
    await ref.update({ reserved_quantity: 2 }); // as a reservation (M5) would
    expect((await importDemoCsv()).body.status).toBe('COMPLETED');
    expect((await ref.get()).data()).toMatchObject({
      quantity: 5,
      reserved_quantity: 2,
      availability_status: 'LOW_STOCK',
    });
    expect((await db.collection(`brands/${BRAND}/stores`).get()).size).toBe(4);
  });

  it('each RETAIL_ADMIN sees only its own store’s stock (same retailer, different stores)', async () => {
    const admin = call(tokens.brandAdmin!);
    for (const [storeId, email, key] of [
      ['st_north_1', 'owner-bandra@m3.test', 'bandra'],
      ['st_north_2', 'owner-andheri@m3.test', 'andheri'],
    ] as const) {
      const res = await admin.post(`/api/brand/stores/${storeId}/admins`, { email });
      expect(res.status).toBe(201);
      const { uid } = await auth.getUserByEmail(email);
      await auth.updateUser(uid, { password: PASSWORD });
      tokens[key] = await signIn(email);
    }

    const bandra = await call(tokens.bandra!).get('/api/retail/stores/st_north_1/inventory');
    expect(bandra.status).toBe(200);
    expect(bandra.body.items).toHaveLength(10);
    expect(bandra.body.items.find((i: { sku: string }) => i.sku === 'DBC-VCSERUM-30')).toMatchObject({
      product_title: 'Vitamin C Glow Serum',
      quantity: 3,
      available_quantity: 3,
      availability_status: 'LOW_STOCK',
    });

    expect((await call(tokens.bandra!).get('/api/retail/stores/st_north_2/inventory')).status).toBe(404);
    expect((await call(tokens.andheri!).get('/api/retail/stores/st_north_1/inventory')).status).toBe(404);
    expect((await call(tokens.andheri!).get('/api/retail/stores/st_north_2/inventory')).status).toBe(200);
    expect((await call(tokens.bandra!).post('/api/integrations/shopify/sync')).status).toBe(403);
    expect((await call(tokens.bandra!).get('/api/brand/retail-imports')).status).toBe(403);
  });
});
