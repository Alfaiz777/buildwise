/**
 * Change 16, UI-5: the Platform Console's retail view — brand and store AGGREGATES only.
 * The flag rules and totals on fixed inputs; the two routes on the scenario world, with
 * the privacy assertion that no customer, message, phone, email, pickup code, stock line
 * or Store Admin identity ever appears.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  brandAggregate,
  storeHealth,
  sumAggregates,
  type NetworkReservation,
  type NetworkStore,
} from '../src/domain/platformNetwork.js';
import { bearer } from './helpers.js';
import { buildScenarioWorld, type ScenarioWorld } from './scenarioWorld.js';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const store = (over: Partial<NetworkStore> = {}): NetworkStore => ({
  storeId: 'st_1',
  storeName: 'Andheri Store',
  city: 'Mumbai',
  status: 'ACTIVE',
  retailerId: 'rtl_1',
  storeAdminProvisioned: true,
  stock: { skuCount: 9, updatedAt: ago(60), stale: false },
  ...over,
});
const hold = (status: string, over: Partial<NetworkReservation> = {}): NetworkReservation => ({
  storeId: 'st_1',
  sku: 'SERUM-30',
  quantity: 1,
  status,
  createdAt: ago(120),
  expiresAt: ago(100),
  cancelledBy: null,
  cancelReason: null,
  ...over,
});

describe('storeHealth flags', () => {
  it('a healthy store has no flags; counts come from its own holds and lookups', () => {
    const row = storeHealth({
      store: store(),
      periodHolds: [hold('COMPLETED'), hold('COMPLETED'), hold('EXPIRED'), hold('COMPLETED', { storeId: 'other' })],
      activeHolds: [],
      lookups: [
        { kind: 'PROPOSED', nearestStoreId: 'st_1', nearestReason: null },
        { kind: 'PROPOSED', nearestStoreId: 'other', nearestReason: null },
      ],
      now: NOW,
    });
    expect(row).toMatchObject({
      holds: 3,
      completed: 2,
      expired: 1,
      completion_pct: 67,
      nearest_lookups: 1,
      fill_pct: 100,
      stock: { sku_count: 9, freshness: 'FRESH' },
      flags: [],
    });
  });

  it('flags in rule order: no stock, no Store Admin, low fill, high refusals, stale holds', () => {
    const row = storeHealth({
      store: store({ storeAdminProvisioned: false, stock: { skuCount: 0, updatedAt: null, stale: false } }),
      periodHolds: [
        hold('COMPLETED'),
        hold('CANCELLED', { cancelledBy: 'RETAILER', cancelReason: 'DAMAGED' }),
        hold('CANCELLED', { cancelledBy: 'RETAILER', cancelReason: 'NOT_ACTUALLY_IN_STOCK' }),
      ],
      activeHolds: [hold('PENDING', { createdAt: ago(45), expiresAt: ago(-10) })],
      lookups: Array.from({ length: 5 }, (_, i) => ({
        kind: 'UNMET_DEMAND' as const,
        nearestStoreId: 'st_1',
        nearestReason: i < 4 ? 'OUT_OF_STOCK' : null,
      })),
      now: NOW,
    });
    expect(row.flags).toEqual([
      'NO_STOCK_UPLOAD',
      'NO_STORE_ADMIN',
      'LOW_FILL_RATE',
      'HIGH_REFUSAL_RATE',
      'STALE_HOLDS',
    ]);
    expect(row.refused).toEqual({ NOT_ACTUALLY_IN_STOCK: 1, DAMAGED: 1, STORE_CLOSING_EARLY: 0, OTHER: 0 });
    expect(row.stock.freshness).toBe('NONE');
    expect(row.stale_holds).toBe(1);
  });

  it('stale stock is flagged when there is stock; a fresh PENDING hold is not stale', () => {
    const row = storeHealth({
      store: store({ stock: { skuCount: 3, updatedAt: ago(3 * 24 * 60), stale: true } }),
      periodHolds: [],
      activeHolds: [hold('PENDING', { createdAt: ago(5), expiresAt: ago(-15) })],
      lookups: [],
      now: NOW,
    });
    expect(row.flags).toEqual(['STALE_STOCK']);
    expect(row.stock.freshness).toBe('STALE');
  });
});

describe('brandAggregate and platform totals', () => {
  it('value = completed quantity × the store’s offline price; rates from summed parts', () => {
    const a = brandAggregate({
      stores: [store(), store({ storeId: 'st_2', storeAdminProvisioned: false })],
      periodHolds: [hold('COMPLETED', { quantity: 2 }), hold('EXPIRED'), hold('PENDING')],
      lookups: [
        { kind: 'PROPOSED', nearestStoreId: 'st_1', nearestReason: null },
        { kind: 'UNMET_DEMAND', nearestStoreId: 'st_1', nearestReason: 'OUT_OF_STOCK' },
      ],
      outcomes: [
        { purchaseType: 'OFFLINE', value: 795, currency: 'INR' },
        { purchaseType: 'ONLINE', value: 1195, currency: 'INR' },
        { purchaseType: 'NONE', value: 0, currency: null },
      ],
      followUpsSent: 4,
      offlinePrice: () => 800,
      currency: 'INR',
    });
    expect(a).toEqual({
      stores_total: 2,
      stores_live: 1,
      holds: 3,
      pickups: 1,
      offline_value: { amount: 1600, currency: 'INR' },
      online_orders: 1,
      online_value: { amount: 1195, currency: 'INR' },
      completion_pct: 50, // 1 picked up of 2 finished (the PENDING hold is left out)
      fill_pct: 50,
      unmet_demand: 1,
      follow_ups_sent: 4,
    });
    const totals = sumAggregates([
      { aggregate: a, finished: 2, nearest: 2, nearestHadStock: 1 },
      { aggregate: { ...a, pickups: 3 }, finished: 4, nearest: 8, nearestHadStock: 8 },
    ]);
    expect(totals.completion_pct).toBe(67); // (1 + 3) ÷ (2 + 4), not the average of 50 % and 75 %
    expect(totals.fill_pct).toBe(90); // (1 + 8) ÷ (2 + 8)
  });
});

const patch = (s: ScenarioWorld, user: string, id: string, body: Record<string, unknown>) =>
  request(s.world.app).patch(`/api/reservations/${id}`).set('Authorization', bearer(user)).send(body);

async function held(s: ScenarioWorld, ref: string) {
  await s.startFromStore(ref, 'need it today please, my number is 98765 43210');
  await s.share(ref);
  const hold = await s.tap(ref, 'hold:sc_A');
  const id = hold.body.decision.executed_action.reservation_id as string;
  return { id, pickupCode: s.world.reservations.reservations.find((r) => r.reservationId === id)!.pickupCode };
}

describe('GET /api/platform/network and /brands/:brandId/network', () => {
  async function world() {
    const s = await buildScenarioWorld();
    const brand = s.world.brands.brands.find((b) => b.brandId === 'brand_A')!;
    brand.settings = {
      ...brand.settings,
      messaging: { ...(brand.settings.messaging as object), whatsapp_number: '+91 98765 43210' },
    };
    const done = await held(s, 'c1');
    for (const [to, from] of [
      ['CONFIRMED', 'PENDING'],
      ['READY', 'CONFIRMED'],
      ['CUSTOMER_ARRIVED', 'READY'],
    ]) {
      await patch(s, 'radmin_scA', done.id, { status: to, expected_current_status: from });
    }
    await patch(s, 'radmin_scA', done.id, {
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: done.pickupCode,
    });
    const refused = await held(s, 'c2');
    await patch(s, 'radmin_scA', refused.id, {
      status: 'CANCELLED',
      expected_current_status: 'PENDING',
      cancel_reason: 'DAMAGED',
    });
    const open = await held(s, 'c3');
    return { s, codes: [done.pickupCode, refused.pickupCode, open.pickupCode] };
  }

  it('returns aggregates whose numbers match the records', async () => {
    const { s } = await world();
    const res = await s.get('/api/platform/network?days=7&include_history=true', 'platform');
    expect(res.status).toBe(200);
    const brand = res.body.brands.find((b: { brand_id: string }) => b.brand_id === 'brand_A');
    const sku = s.world.reservations.reservations[0]!.sku;
    const price = s.world.inventory.rows.find(
      (r) => r.brandId === 'brand_A' && r.storeId === 'sc_A' && r.sku === sku,
    )!.offlinePrice;
    expect(brand).toMatchObject({
      name: 'Brand brand_A',
      holds: 3,
      pickups: 1,
      offline_value: { amount: price, currency: 'INR' },
      completion_pct: 50, // 1 picked up ÷ 2 finished (one hold is still active)
    });
    expect(res.body.totals).toMatchObject({ holds: expect.any(Number), pickups: expect.any(Number) });
    expect(res.body.totals.brands_active).toBeGreaterThanOrEqual(1);

    const detail = await s.get('/api/platform/brands/brand_A/network?days=7', 'platform');
    expect(detail.status).toBe(200);
    const all = [
      ...detail.body.retailers.flatMap((r: { stores: unknown[] }) => r.stores),
      ...detail.body.unassigned_stores,
    ] as {
      store_id: string;
      holds: number;
      completed: number;
      refused: Record<string, number>;
      active_holds: number;
    }[];
    expect(all.find((x) => x.store_id === 'sc_A')).toMatchObject({
      holds: 3,
      completed: 1,
      refused: { DAMAGED: 1 },
      active_holds: 1,
    });
  });

  it('never returns customers, messages, phones, emails, pickup codes, stock lines or Store Admin identities', async () => {
    const { s, codes } = await world();
    const bodies = [
      (await s.get('/api/platform/network?days=28', 'platform')).body,
      (await s.get('/api/platform/brands/brand_A/network?days=28', 'platform')).body,
    ];
    const text = JSON.stringify(bodies);
    for (const forbidden of [
      'sim:',
      'customer',
      'need it today',
      '98765',
      '43210',
      '@',
      'pickup_code',
      '"sku"',
      'quantity',
      'reserved_quantity',
      'offline_price',
      'retail_admin_user_id',
      'radmin_',
      'admin_a',
      'conversation_id',
      'evidence',
      'latitude',
      'longitude',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    for (const code of codes) expect(text).not.toContain(code);
  });

  it('platform only: tenants are refused; an unknown brand is 404; tenant routes stay closed to the platform', async () => {
    const { s } = await world();
    expect((await s.get('/api/platform/network', 'admin_a')).status).toBe(403);
    expect((await s.get('/api/platform/network', 'radmin_scA')).status).toBe(403);
    expect((await s.get('/api/platform/brands/brand_A/network', 'admin_a')).status).toBe(403);
    expect((await s.get('/api/platform/brands/brand_ZZZ/network', 'platform')).status).toBe(404);
    expect((await s.get('/api/platform/network?days=3', 'platform')).status).toBe(400);
    expect((await s.get('/api/reservations', 'platform')).status).toBe(403);
    expect((await s.get('/api/brand/conversations', 'platform')).status).toBe(403);
  });
});

describe('GET /api/platform/audit (UI-5)', () => {
  it('names the brand and the actor’s role, keeps the reason and result', async () => {
    const s = await buildScenarioWorld();
    await request(s.world.app)
      .patch('/api/platform/brands/brand_A')
      .set('Authorization', bearer('platform'))
      .send({ status: 'SUSPENDED', reason: 'Payment overdue' });
    const res = await s.get('/api/platform/audit?limit=10', 'platform');
    expect(res.body.events[0]).toMatchObject({
      action: 'BRAND_SUSPENDED',
      target_brand_id: 'brand_A',
      target_brand_name: 'Brand brand_A',
      actor_role: 'PLATFORM_ADMIN',
      reason_code: 'Payment overdue',
      result: 'SUCCESS',
    });
    expect(JSON.stringify(res.body)).not.toContain('@');
  });
});
