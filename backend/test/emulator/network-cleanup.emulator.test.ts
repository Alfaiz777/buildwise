/**
 * L5 cleanup on the Firebase emulators with the REAL composition root: a demo brand seeded
 * before L5 (North Retail, Pune Retail, Bandra / Andheri / Powai / Koregaon Park) is reset into
 * exactly the six Ahmedabad stores under "Ahmedabad Retail Partners". The Firestore deletes are
 * guarded (a store with a Retail Admin, a retailer with a store) and run in batches.
 *
 * Run from the repo root: npm run test:emulator
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FirestoreInventoryRepository,
  FirestoreRetailerRepository,
  FirestoreStoreRepository,
} from '../../src/adapters/firestore/repositories.js';
import { buildContainer } from '../../src/composition/container.js';
import { loadConfig } from '../../src/config/env.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { silentLogger } from '../../src/lib/logger.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const DEMO = 'brd_cleanup_demo';
const SEED = { type: 'SYSTEM' as const, id: 'seed-test' };
const clock = { t: Date.parse('2026-10-07T06:30:00.000Z') };

let dataDir = '';
let db: ReturnType<typeof initFirebase>['db'];
let container: ReturnType<typeof buildContainer>;
let stores: FirestoreStoreRepository;
let retailers: FirestoreRetailerRepository;
let inventory: FirestoreInventoryRepository;

const oldStore = (storeId: string, storeName: string, city: string, latitude: number, longitude: number) => ({
  storeId,
  storeName,
  city,
  address: `${storeName}, ${city}`,
  latitude,
  longitude,
  storeHours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
  storeStatus: 'ACTIVE' as const,
  reservationAvailable: true,
  pickupAvailable: true,
});

const ids = async (path: string) => (await db.collection(path).get()).docs.map((d) => d.id).sort();

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'qwikspot-cleanup-'));
  const config = loadConfig({
    ...process.env,
    QWIKSPOT_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
    DEMO_MODE: 'true',
    DEMO_BRAND_IDS: DEMO,
  });
  container = buildContainer(config, silentLogger, { now: () => new Date(clock.t) });
  ({ db } = initFirebase(PROJECT, config.emulators));
  stores = new FirestoreStoreRepository(db);
  retailers = new FirestoreRetailerRepository(db);
  inventory = new FirestoreInventoryRepository(db);

  // The demo brand as a live project seeded before L5.
  await db.doc(`brands/${DEMO}`).set({ brand_id: DEMO, name: 'Demo Beauty Co', status: 'ACTIVE', settings: {} });
  await retailers.create({ brandId: DEMO, retailerId: 'rtl_north', name: 'North Retail' });
  await retailers.create({ brandId: DEMO, retailerId: 'rtl_pune', name: 'Pune Retail' });
  await stores.upsertFromImport(DEMO, [
    oldStore('st_north_1', 'Bandra Store', 'Mumbai', 19.0544, 72.8267),
    oldStore('st_north_2', 'Andheri Store', 'Mumbai', 19.1364, 72.8296),
    oldStore('st_north_3', 'Powai Store', 'Mumbai', 19.1176, 72.906),
    oldStore('st_pune_1', 'Koregaon Park Store', 'Pune', 18.5362, 73.8939),
  ]);
  for (const [storeId, retailerId, admin] of [
    ['st_north_1', 'rtl_north', 'uid_north_1'],
    ['st_north_2', 'rtl_north', 'uid_north_2'],
    ['st_north_3', 'rtl_north', null],
    ['st_pune_1', 'rtl_pune', null],
  ] as const) {
    await db.doc(`brands/${DEMO}/stores/${storeId}`).update({ retailer_id: retailerId, retail_admin_user_id: admin });
  }
}, 120_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('L5 network cleanup (Firestore)', () => {
  it('the guarded deletes: a store with a Retail Admin and a retailer with a store are never deleted', async () => {
    expect(await stores.deleteIfUnclaimed(DEMO, 'st_north_1')).toBe(false);
    expect(await stores.deleteIfUnclaimed(DEMO, 'st_missing')).toBe(false);
    expect(await retailers.deleteIfEmpty(DEMO, 'rtl_pune')).toBe(false); // st_pune_1 still belongs to it
    expect(await retailers.rename(DEMO, 'rtl_missing', 'x')).toBe(false);
    expect(await ids(`brands/${DEMO}/stores`)).toEqual(['st_north_1', 'st_north_2', 'st_north_3', 'st_pune_1']);
  });

  it('deleteByStore removes more rows than one batch holds, and only that store’s', async () => {
    const col = db.collection(`brands/${DEMO}/retailInventory`);
    for (let i = 0; i < 520; i += 260) {
      const batch = db.batch();
      for (let j = i; j < i + 260; j++)
        batch.set(col.doc(`st_bulk__SKU-${j}`), { store_id: 'st_bulk', sku: `SKU-${j}` });
      await batch.commit();
    }
    await col.doc('st_north_3__DBC-VCSERUM-30').set({ store_id: 'st_north_3', sku: 'DBC-VCSERUM-30' });
    expect(await inventory.deleteByStore(DEMO, 'st_bulk')).toBe(520);
    expect(await ids(`brands/${DEMO}/retailInventory`)).toEqual(['st_north_3__DBC-VCSERUM-30']);
  });

  it('Reset demo leaves the six Ahmedabad stores under one renamed retailer; the admins keep their stores', async () => {
    const result = await container.demoReset.rebuild(DEMO, SEED);
    expect(result.network).toMatchObject({
      storesDeleted: ['st_north_3', 'st_pune_1'],
      storesRetired: [],
      retailersDeleted: ['rtl_pune'],
      retailerRenamed: { retailerId: 'rtl_north', from: 'North Retail', to: 'Ahmedabad Retail Partners' },
    });
    expect(await ids(`brands/${DEMO}/stores`)).toEqual([
      'st_nav_2',
      'st_nav_3',
      'st_north_1',
      'st_north_2',
      'st_sat_2',
      'st_sat_3',
    ]);
    expect(await ids(`brands/${DEMO}/retailers`)).toEqual(['rtl_north']);
    expect((await db.doc(`brands/${DEMO}/retailers/rtl_north`).get()).get('name')).toBe('Ahmedabad Retail Partners');
    for (const [storeId, admin, name] of [
      ['st_north_1', 'uid_north_1', 'Wellness Mart'],
      ['st_north_2', 'uid_north_2', 'HealthPlus Chemist'],
    ]) {
      expect((await db.doc(`brands/${DEMO}/stores/${storeId}`).get()).data()).toMatchObject({
        store_name: name,
        retailer_id: 'rtl_north',
        retail_admin_user_id: admin,
        store_status: 'ACTIVE',
      });
    }
    const stock = await db.collection(`brands/${DEMO}/retailInventory`).get();
    expect(stock.docs.some((d) => ['st_north_3', 'st_pune_1'].includes(String(d.get('store_id'))))).toBe(false);
    const audit = await db.collection(`brands/${DEMO}/auditEvents`).where('action', '==', 'DEMO_RESET').get();
    expect(audit.docs.map((d) => d.get('reason_code'))).toEqual([
      expect.stringMatching(
        /;stores_deleted=st_north_3,st_pune_1;retailers_deleted=rtl_pune;retailer_renamed=rtl_north$/,
      ),
    ]);
  }, 120_000);

  it('a second reset changes nothing in the network', async () => {
    const before = (await db.collection(`brands/${DEMO}/retailInventory`).get()).docs
      .map((d) => [d.id, d.get('quantity')])
      .sort();
    const again = await container.demoReset.rebuild(DEMO, SEED);
    expect(again.network).toEqual({
      storesDeleted: [],
      storesRetired: [],
      retailersDeleted: [],
      retailerRenamed: null,
      stockRowsDeleted: 0,
    });
    expect(await ids(`brands/${DEMO}/stores`)).toHaveLength(6);
    expect(await ids(`brands/${DEMO}/retailers`)).toEqual(['rtl_north']);
    expect(
      (await db.collection(`brands/${DEMO}/retailInventory`).get()).docs.map((d) => [d.id, d.get('quantity')]).sort(),
    ).toEqual(before);
  }, 120_000);
});
