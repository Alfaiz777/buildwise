/**
 * Reset demo (Change 14, G4) through the HTTP API on the in-memory world: who may reset,
 * the rate limit, the audit event and the order of the steps. The Firestore wipe itself
 * (counts equal after reset, other brands untouched) is proven on the emulator.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, buildTestWorld } from './helpers.js';
import { FakeShopify } from './shopifyFakes.js';

const DEMO = { enabled: true, brandIds: ['brand_A'], holdMinutes: 20, logins: [] };
const reset = (app: Parameters<typeof request>[0], user: string) =>
  request(app).post('/api/brand/demo/reset').set('Authorization', bearer(user));

describe('POST /api/brand/demo/reset', () => {
  it('DEMO_MODE off → 404 and nothing is touched', async () => {
    const w = buildTestWorld();
    const res = await reset(w.app, 'admin_a');
    expect(res.status).toBe(404);
    expect(w.demoData.calls).toEqual([]);
    expect((await request(w.app).get('/api/brand/demo').set('Authorization', bearer('admin_a'))).body).toEqual({
      reset_available: false,
    });
  });

  it('a brand that is not an allowlisted demo brand → 403, audited as DENIED', async () => {
    const w = buildTestWorld({ demo: DEMO });
    const res = await reset(w.app, 'admin_b');
    expect([res.status, res.body.error.code]).toEqual([403, 'DEMO_RESET_NOT_ALLOWED']);
    expect(w.demoData.calls).toEqual([]);
    expect(w.audit.brandEvents.at(-1)).toMatchObject({ brandId: 'brand_B', action: 'DEMO_RESET', result: 'DENIED' });
  });

  it('Retail Admins and the Platform Admin cannot reset (403); DEMO_MODE never widens a role', async () => {
    const w = buildTestWorld({ demo: DEMO });
    for (const user of ['radmin_A', 'platform']) {
      const res = await reset(w.app, user);
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect(w.demoData.calls).toEqual([]);
  });

  it('the demo brand’s Brand Admin resets: wipe → settings → sync → stock → history, audited; again within a minute → 429', async () => {
    const w = buildTestWorld({ demo: DEMO });
    expect((await request(w.app).get('/api/brand/demo').set('Authorization', bearer('admin_a'))).body).toEqual({
      reset_available: true,
    });
    const res = await reset(w.app, 'admin_a');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(w.demoData.calls).toEqual(['wipe:brand_A', 'settings:brand_A', 'history:brand_A']);
    expect(res.body).toMatchObject({ brand_id: 'brand_A', catalog: { products: expect.any(Number) } });
    expect(res.body.catalog.products).toBeGreaterThan(0);
    const brand = w.brands.brands.find((b) => b.brandId === 'brand_A')!;
    expect(brand.settings).toMatchObject({ reservation_policy: { hold_minutes: 20 } });
    expect(w.audit.brandEvents.at(-1)).toMatchObject({
      brandId: 'brand_A',
      actorType: 'USER',
      actorId: 'admin_a',
      action: 'DEMO_RESET',
      result: 'SUCCESS',
    });
    const again = await reset(w.app, 'admin_a');
    expect([again.status, again.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    // Judge-test plan: the exact words the demo guide shows.
    expect(again.body.error.message).toBe('The demo was just reset. Try again in a minute.');
    expect(w.demoData.calls).toHaveLength(3);
  });
});

describe('Reset demo before the Shopify store is connected (L1, fresh gcp project)', () => {
  it('rebuilds the brand and its stores, skips catalogue and history, and says the store must be connected', async () => {
    const w = buildTestWorld({ demo: DEMO, shopify: new FakeShopify() });
    const res = await reset(w.app, 'admin_a');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ pending: 'SHOPIFY_NOT_CONNECTED', catalog: { products: 0 }, history: {} });
    // The judge stock file still ran (it creates the stores seed:live provisions admins for).
    expect(res.body.stock.status).toBe('COMPLETED');
    expect(w.demoData.calls).toEqual(['wipe:brand_A', 'settings:brand_A']);
    expect(w.audit.brandEvents.at(-1)).toMatchObject({ action: 'DEMO_RESET', result: 'SUCCESS' });
  });

  it('with the mock catalogue nothing is pending', async () => {
    const res = await reset(buildTestWorld({ demo: DEMO }).app, 'admin_a');
    expect(res.body.pending).toBeNull();
  });
});

describe('Reset demo rebuilds the Ahmedabad network (L5)', () => {
  it('the six area stores are active; a store of an older network keeps its admin but becomes INACTIVE', async () => {
    const w = buildTestWorld({ demo: DEMO });
    w.retailers.retailers.push({
      brandId: 'brand_A',
      retailerId: 'rtl_north',
      name: 'Ahmedabad Retail Partners',
      status: 'ACTIVE',
    });
    await w.stores.upsertFromImport('brand_A', [
      {
        storeId: 'st_north_3',
        storeName: 'Powai Store',
        city: 'Mumbai',
        address: 'Hiranandani Gardens, Powai',
        latitude: 19.1176,
        longitude: 72.906,
        storeHours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
        storeStatus: 'ACTIVE',
        reservationAvailable: true,
        pickupAvailable: true,
      },
    ]);
    const old = w.stores.stores.find((s) => s.brandId === 'brand_A' && s.storeId === 'st_north_3')!;
    old.retailerId = 'rtl_north';
    old.retailAdminUserId = 'radmin_old';

    const res = await reset(w.app, 'admin_a');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stores = w.stores.stores.filter((s) => s.brandId === 'brand_A');
    expect(
      stores
        .filter((s) => s.area)
        .map((s) => [s.storeId, s.area, s.storeStatus])
        .sort(),
    ).toEqual(
      [
        ['st_nav_2', 'Navrangpura', 'ACTIVE'],
        ['st_nav_3', 'Navrangpura', 'ACTIVE'],
        ['st_north_1', 'Satellite', 'ACTIVE'],
        ['st_north_2', 'Navrangpura', 'ACTIVE'],
        ['st_sat_2', 'Satellite', 'ACTIVE'],
        ['st_sat_3', 'Satellite', 'ACTIVE'],
      ].sort(),
    );
    expect(await w.stores.get('brand_A', 'st_north_3')).toMatchObject({
      storeStatus: 'INACTIVE',
      retailerId: 'rtl_north',
      retailAdminUserId: 'radmin_old',
    });
    expect(stores.filter((s) => s.storeStatus === 'ACTIVE' && !s.area)).toEqual([]);
  });
});

describe('Reset demo removes the old Mumbai / Pune network (L5 cleanup)', () => {
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

  /** brand_A as a live project seeded before L5: North Retail, Pune Retail, four stores, two admins. */
  async function oldNetwork() {
    const w = buildTestWorld({ demo: DEMO });
    w.stores.stores.splice(0, w.stores.stores.length, ...w.stores.stores.filter((s) => s.brandId !== 'brand_A'));
    w.retailers.retailers.splice(
      0,
      w.retailers.retailers.length,
      ...w.retailers.retailers.filter((r) => r.brandId !== 'brand_A'),
      { brandId: 'brand_A', retailerId: 'rtl_north', name: 'North Retail', status: 'ACTIVE' },
      { brandId: 'brand_A', retailerId: 'rtl_pune', name: 'Pune Retail', status: 'ACTIVE' },
    );
    await w.stores.upsertFromImport('brand_A', [
      oldStore('st_north_1', 'Bandra Store', 'Mumbai', 19.0544, 72.8267),
      oldStore('st_north_2', 'Andheri Store', 'Mumbai', 19.1364, 72.8296),
      oldStore('st_north_3', 'Powai Store', 'Mumbai', 19.1176, 72.906),
      oldStore('st_pune_1', 'Koregaon Park Store', 'Pune', 18.5362, 73.8939),
    ]);
    for (const [storeId, retailerId, admin] of [
      ['st_north_1', 'rtl_north', 'radmin_n1'],
      ['st_north_2', 'rtl_north', 'radmin_n2'],
      ['st_north_3', 'rtl_north', null],
      ['st_pune_1', 'rtl_pune', null],
    ] as const) {
      const s = w.stores.stores.find((x) => x.brandId === 'brand_A' && x.storeId === storeId)!;
      s.retailerId = retailerId;
      s.retailAdminUserId = admin;
      if (admin)
        w.users.users.push({
          userId: admin,
          role: 'RETAIL_ADMIN',
          brandId: 'brand_A',
          retailerId,
          storeId,
          email: `${admin}@example.test`,
          status: 'ACTIVE',
        });
    }
    return w;
  }
  type World = Awaited<ReturnType<typeof oldNetwork>>;
  const brandStores = (w: World) => w.stores.stores.filter((s) => s.brandId === 'brand_A');
  const stockOf = (w: World) =>
    w.inventory.rows
      .filter((r) => r.brandId === 'brand_A')
      .map((r) => [r.inventoryId, r.quantity, r.reservedQuantity])
      .sort();

  it('leaves exactly the six area stores under one retailer, "Ahmedabad Retail Partners"; admins still sign in', async () => {
    const w = await oldNetwork();
    const res = await reset(w.app, 'admin_a');
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(
      brandStores(w)
        .map((s) => [s.storeId, s.storeName, s.area, s.storeStatus, s.retailerId])
        .sort(),
    ).toEqual(
      [
        ['st_north_1', 'Wellness Mart', 'Satellite', 'ACTIVE', 'rtl_north'],
        ['st_sat_2', 'GlowUp Beauty', 'Satellite', 'ACTIVE', 'rtl_north'],
        ['st_sat_3', 'CityCare Pharmacy', 'Satellite', 'ACTIVE', 'rtl_north'],
        ['st_north_2', 'HealthPlus Chemist', 'Navrangpura', 'ACTIVE', 'rtl_north'],
        ['st_nav_2', 'Skin Studio', 'Navrangpura', 'ACTIVE', 'rtl_north'],
        ['st_nav_3', 'MediGlow Pharmacy', 'Navrangpura', 'ACTIVE', 'rtl_north'],
      ].sort(),
    );
    expect(w.retailers.retailers.filter((r) => r.brandId === 'brand_A')).toEqual([
      { brandId: 'brand_A', retailerId: 'rtl_north', name: 'Ahmedabad Retail Partners', status: 'ACTIVE' },
    ]);
    // No stock row is left for a deleted store.
    expect(w.inventory.rows.some((r) => ['st_north_3', 'st_pune_1'].includes(r.storeId))).toBe(false);
    expect(res.body.network).toEqual({
      stores_deleted: ['st_north_3', 'st_pune_1'],
      stores_inactive: [],
      retailers_deleted: ['rtl_pune'],
      retailer_renamed: { retailerId: 'rtl_north', from: 'North Retail', to: 'Ahmedabad Retail Partners' },
    });
    expect(res.body.deleted).toMatchObject({ stores: 2, retailers: 1 });
    expect(w.audit.brandEvents.at(-1)).toMatchObject({
      action: 'DEMO_RESET',
      result: 'SUCCESS',
      reasonCode: expect.stringMatching(
        /;stores_deleted=st_north_3,st_pune_1;retailers_deleted=rtl_pune;retailer_renamed=rtl_north$/,
      ),
    });

    // The two Retail Admins keep their stores, now with the Ahmedabad names.
    for (const [admin, storeId, name, area] of [
      ['radmin_n1', 'st_north_1', 'Wellness Mart', 'Satellite'],
      ['radmin_n2', 'st_north_2', 'HealthPlus Chemist', 'Navrangpura'],
    ] as const) {
      const me = await request(w.app).get('/api/me').set('Authorization', bearer(admin));
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        role: 'RETAIL_ADMIN',
        store_id: storeId,
        retailer_name: 'Ahmedabad Retail Partners',
        store: { store_name: name, area },
      });
    }
  });

  it('a second reset is a no-op for the network: same stores, retailer and stock', async () => {
    const w = await oldNetwork();
    expect((await reset(w.app, 'admin_a')).status).toBe(200);
    const stores = brandStores(w).map((s) => ({ ...s }));
    const stock = stockOf(w);
    const again = await w.demoReset.rebuild('brand_A', { type: 'SYSTEM', id: 'test' });
    expect(again.network).toEqual({
      storesDeleted: [],
      storesRetired: [],
      retailersDeleted: [],
      retailerRenamed: null,
      stockRowsDeleted: 0,
    });
    expect(brandStores(w)).toEqual(stores);
    expect(stockOf(w)).toEqual(stock);
    expect(w.retailers.retailers.filter((r) => r.brandId === 'brand_A').map((r) => r.name)).toEqual([
      'Ahmedabad Retail Partners',
    ]);
  });

  it('an old store that has a Retail Admin is kept INACTIVE, and so is its retailer', async () => {
    const w = await oldNetwork();
    w.stores.stores.find((s) => s.storeId === 'st_pune_1')!.retailAdminUserId = 'radmin_pune';
    const res = await reset(w.app, 'admin_a');
    expect(res.status).toBe(200);
    expect(await w.stores.get('brand_A', 'st_pune_1')).toMatchObject({
      storeStatus: 'INACTIVE',
      retailerId: 'rtl_pune',
      retailAdminUserId: 'radmin_pune',
    });
    expect(await w.stores.get('brand_A', 'st_north_3')).toBeNull();
    expect(
      w.retailers.retailers
        .filter((r) => r.brandId === 'brand_A')
        .map((r) => r.retailerId)
        .sort(),
    ).toEqual(['rtl_north', 'rtl_pune']);
    expect(res.body.network).toMatchObject({ stores_deleted: ['st_north_3'], stores_inactive: ['st_pune_1'] });
  });
});
