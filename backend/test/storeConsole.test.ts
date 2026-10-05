/**
 * Change 16, UI-4: the Store Console reads — "why this hold came to you" (store names and
 * this store's distance only), the value strip and the store-scoped insights slice.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { storeSlice, type InsightCatalog, type InsightRows } from '../src/domain/insights.js';
import { whyThisStore, type StoreTrace } from '../src/domain/storeReason.js';
import { bearer } from './helpers.js';
import { buildScenarioWorld, type ScenarioWorld } from './scenarioWorld.js';

const trace = (
  eligible: [string, string, number][],
  excluded: [string, string, string, number | null][],
): StoreTrace => ({
  eligible: eligible.map(([store_id, store_name, distance_km]) => ({
    store_id,
    store_name,
    distance_km,
    variant_id: 'v30',
  })),
  excluded: excluded.map(([store_id, store_name, reason, distance_km]) => ({
    store_id,
    store_name,
    reason,
    distance_km,
    variant_id: 'v30',
  })),
});

describe('whyThisStore (Andheri’s view)', () => {
  it('a nearer store was out of stock', () => {
    const why = whyThisStore(
      trace(
        [['and', 'Andheri Store', 7.62]],
        [
          ['pow', 'Powai Store', 'OUT_OF_STOCK', 0.68],
          ['ban', 'Bandra Store', 'TOO_FAR', 10.6],
        ],
      ),
      'and',
      'v30',
    );
    expect(why).toEqual({
      text: 'Powai Store was closer but out of stock. You were the nearest store with stock — 7.6 km from the customer.',
      distance_km: 7.6,
      closer_unavailable: [{ store_name: 'Powai Store', reason: 'OUT_OF_STOCK' }],
      options: 1,
    });
  });

  it('simply the nearest store with stock', () => {
    expect(
      whyThisStore(trace([['and', 'Andheri Store', 0.71]], [['pow', 'Powai Store', 'TOO_FAR', 11]]), 'and', 'v30')!
        .text,
    ).toBe('You were the nearest store with stock — 0.7 km from the customer.');
  });

  it('the customer chose this store from a list (a nearer one had stock)', () => {
    const why = whyThisStore(
      trace(
        [
          ['ban', 'Bandra Store', 0.7],
          ['and', 'Andheri Store', 8.5],
          ['kor', 'Colaba Store', 9.9],
        ],
        [],
      ),
      'and',
      'v30',
    )!;
    expect(why.text).toBe('The customer chose you from 3 stores with stock (8.5 km away; Bandra Store was nearer).');
    expect(why.options).toBe(3);
  });

  it('a store that refused the earlier hold is the reason, never a store the customer passed over', () => {
    const t = trace(
      [
        ['st_bandra', 'Bandra Store', 0.7],
        ['st_andheri', 'Andheri Store', 8.5],
      ],
      [],
    );
    expect(whyThisStore(t, 'st_andheri', 'v30', [{ store_id: 'st_bandra', store_name: 'Bandra Store' }])).toEqual({
      text: "Bandra Store couldn't fulfil the customer's hold, so it came to you — 8.5 km from the customer.",
      distance_km: 8.5,
      closer_unavailable: [{ store_name: 'Bandra Store', reason: 'REFUSED' }],
      options: 1,
    });
  });

  it('no trace, or a trace that does not describe this store → null; other stores’ distances never appear', () => {
    expect(whyThisStore(null, 'and', 'v30')).toBeNull();
    expect(whyThisStore(trace([['ban', 'Bandra Store', 0.7]], []), 'and', 'v30')).toBeNull();
    const why = whyThisStore(
      trace([['and', 'Andheri Store', 7.62]], [['pow', 'Powai Store', 'OUT_OF_STOCK', 0.68]]),
      'and',
      'v30',
    )!;
    expect(JSON.stringify(why)).not.toMatch(/0\.68|0\.7\b|distance_km":0/);
  });
});

const patch = (s: ScenarioWorld, id: string, body: Record<string, unknown>) =>
  request(s.world.app).patch(`/api/reservations/${id}`).set('Authorization', bearer('radmin_scA')).send(body);

async function held(s: ScenarioWorld, ref = 'c1') {
  await s.startFromStore(ref, 'hi there, need it today');
  await s.share(ref);
  const hold = await s.tap(ref, 'hold:sc_A');
  const id = hold.body.decision.executed_action.reservation_id as string;
  return { id, pickupCode: s.world.reservations.reservations.find((r) => r.reservationId === id)!.pickupCode };
}

describe('store reservation rows: why_here and nothing about the customer', () => {
  it('the store sees why the hold came, its distance, and no location, messages or identity', async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    const res = await s.get('/api/reservations?view=active', 'radmin_scA');
    const row = res.body.reservations.find((r: { reservation_id: string }) => r.reservation_id === id);
    expect(row.why_here).toMatchObject({
      text: expect.stringContaining('from the customer'),
      distance_km: expect.any(Number),
    });
    expect(row).toHaveProperty('image_url');
    expect(row.demo_history).toBe(false);
    const text = JSON.stringify(res.body);
    for (const forbidden of [
      'latitude',
      'longitude',
      '"location"',
      'customer_id',
      'conversation_id',
      'ai_recommendation_id',
      'sim:',
      'need it today',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    const one = await s.get(`/api/reservations/${id}`, 'radmin_scA');
    expect(one.body.why_here).toEqual(row.why_here);
    expect(one.body).not.toHaveProperty('conversation_id');
  });
});

describe('why_here uses the decision that offered the choice', () => {
  it('a farther store picked from "Other stores" says the customer chose it (a nearer one had stock)', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c9', 'need it today');
    await s.share('c9');
    await s.tap('c9', 'other_stores');
    const hold = await s.tap('c9', 'hold:sc_B'); // Worli, 6 km — Colaba (2 km, offered first) also had stock
    expect(hold.body.decision.executed_action?.type).toBe('RESERVATION_CREATED');
    const rows = (await s.get('/api/reservations?view=active', 'radmin_scB')).body.reservations;
    expect(rows[0].why_here.text).toMatch(
      /^The customer chose you from \d+ stores with stock \(6 km away; Colaba Store was nearer\)\.$/,
    );
  });
});

describe('after a refusal (judge-test plan c4 and c6)', () => {
  const refuse = (s: ScenarioWorld, id: string) =>
    request(s.world.app)
      .patch(`/api/reservations/${id}`)
      .set('Authorization', bearer('radmin_scA'))
      .send({ status: 'CANCELLED', expected_current_status: 'PENDING', cancel_reason: 'NOT_ACTUALLY_IN_STOCK' });

  it('c4: the next store sees that the refusing store could not fulfil the hold — not that the customer chose it', async () => {
    const s = await buildScenarioWorld({ overrides: { sc_E: { v1: 0 } } }); // Worli (6 km) is next
    const { id } = await held(s);
    expect((await refuse(s, id)).status).toBe(200);
    const hold = await s.tap('c1', 'hold:sc_B');
    expect(hold.body.decision.executed_action?.type).toBe('RESERVATION_CREATED');
    const rows = (await s.get('/api/reservations?view=active', 'radmin_scB')).body.reservations;
    expect(rows[0].why_here).toEqual({
      text: "Colaba Store couldn't fulfil the customer's hold, so it came to you — 6 km from the customer.",
      distance_km: 6,
      closer_unavailable: [{ store_name: 'Colaba Store', reason: 'REFUSED' }],
      options: 1,
    });
    // The refusing store's reason never travels to the other store.
    expect(JSON.stringify(rows)).not.toMatch(/NOT_ACTUALLY|not actually/i);
  });

  it('c4: a store offered beyond the normal radius after the refusal shows its own distance', async () => {
    const s = await buildScenarioWorld({ overrides: { sc_B: { km: 14 }, sc_C: { v1: 0 }, sc_E: { v1: 0 } } });
    const { id } = await held(s);
    await refuse(s, id);
    expect((await s.tap('c1', 'hold:sc_B')).body.decision.executed_action?.type).toBe('RESERVATION_CREATED');
    const rows = (await s.get('/api/reservations?view=active', 'radmin_scB')).body.reservations;
    expect(rows[0].why_here.text).toBe(
      "Colaba Store couldn't fulfil the customer's hold, so it came to you — 14 km from the customer.",
    );
  });

  it("c6: the refusal is on the refusing store's Demand right away (no process-due needed)", async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    const before = (await s.get('/api/retail/stores/sc_A/insights?days=7', 'radmin_scA')).body;
    expect(before.refusals.NOT_ACTUALLY_IN_STOCK).toBe(0);
    await refuse(s, id);
    const after = (await s.get('/api/retail/stores/sc_A/insights?days=7', 'radmin_scA')).body;
    expect(after.refusals).toMatchObject({ NOT_ACTUALLY_IN_STOCK: 1 });
    expect(after.fill_rate).toContainEqual(expect.objectContaining({ refusals: { NOT_ACTUALLY_IN_STOCK: 1 } }));
    // Another store's Demand does not show it.
    const other = (await s.get('/api/retail/stores/sc_B/insights?days=7', 'radmin_scB')).body;
    expect(other.refusals.NOT_ACTUALLY_IN_STOCK).toBe(0);
  });
});

describe('value strip (last 7 days)', () => {
  it('completion counts finished holds only; value = quantity × the store’s offline price', async () => {
    const s = await buildScenarioWorld();
    const first = await held(s, 'c1');
    for (const [to, from] of [
      ['CONFIRMED', 'PENDING'],
      ['READY', 'CONFIRMED'],
      ['CUSTOMER_ARRIVED', 'READY'],
    ]) {
      await patch(s, first.id, { status: to, expected_current_status: from });
    }
    await patch(s, first.id, {
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: first.pickupCode,
    });
    await held(s, 'c2'); // still active: not in the completion rate
    const price = s.world.inventory.rows.find(
      (r) => r.brandId === 'brand_A' && r.storeId === 'sc_A' && r.sku === s.world.reservations.reservations[0]!.sku,
    )!.offlinePrice!;
    const summary = (await s.get('/api/retail/stores/sc_A/summary', 'radmin_scA')).body;
    expect(summary).toMatchObject({
      reservations: 2,
      completed: 1,
      completion_pct: 100,
      value: { amount: price, currency: 'INR' },
      synthetic: 0,
    });
  });
});

const catalog: InsightCatalog = {
  stores: [
    {
      storeId: 'st_and',
      storeName: 'Andheri Store',
      locality: 'andheri',
      retailerName: 'North Retail',
      timezone: 'Asia/Kolkata',
    },
    {
      storeId: 'st_ban',
      storeName: 'Bandra Store',
      locality: 'bandra',
      retailerName: 'North Retail',
      timezone: 'Asia/Kolkata',
    },
  ],
  variants: [{ variantId: 'v30', sku: 'SERUM-30', label: 'Vitamin C Glow Serum 30 ml' }],
  defaultTimezone: 'Asia/Kolkata',
};
const SAT = '2026-10-03T06:00:00.000Z';
let n = 0;
const lookup = (store: string, reason: string | null) => ({
  eventId: `evt_${++n}`,
  timestamp: SAT,
  kind: reason ? ('UNMET_DEMAND' as const) : ('PROPOSED' as const),
  variantId: 'v30',
  sku: 'SERUM-30',
  area: store === 'st_and' ? 'andheri' : 'bandra',
  excluded: reason ? [{ storeId: store, reason }] : [],
  nearestStoreId: store,
  nearestReason: reason,
  timezone: 'Asia/Kolkata',
});

describe('storeSlice: only this store', () => {
  it('missed demand where it was the nearest, its fill rate and refusals, and only suggestions that name it', () => {
    const rows: InsightRows = {
      intents: [],
      conversations: [],
      recommendations: [],
      lookups: [
        ...Array.from({ length: 4 }, () => lookup('st_and', 'OUT_OF_STOCK')),
        lookup('st_and', null),
        ...Array.from({ length: 5 }, () => lookup('st_ban', 'OUT_OF_STOCK')),
      ],
      reservations: [
        {
          reservationId: 'r1',
          storeId: 'st_and',
          variantId: 'v30',
          status: 'CANCELLED',
          createdAt: SAT,
          cancelledBy: 'RETAILER',
          cancelReason: 'DAMAGED',
        },
        {
          reservationId: 'r2',
          storeId: 'st_ban',
          variantId: 'v30',
          status: 'CANCELLED',
          createdAt: SAT,
          cancelledBy: 'RETAILER',
          cancelReason: 'OTHER',
        },
      ],
      outcomes: [],
    };
    const slice = storeSlice(rows, catalog, 'st_and', 7);
    expect(slice.missed).toEqual([
      { sku: 'SERUM-30', label: 'Vitamin C Glow Serum 30 ml', weekday: 'saturday', reason: 'OUT_OF_STOCK', count: 4 },
    ]);
    expect(slice.fill_rate).toEqual([
      { weekday: 'saturday', nearest: 5, had_stock: 1, fill_pct: 20, refusals: { DAMAGED: 1 } },
    ]);
    expect(slice.refusals).toEqual({ NOT_ACTUALLY_IN_STOCK: 0, DAMAGED: 1, STORE_CLOSING_EARLY: 0, OTHER: 0 });
    for (const s of slice.suggestions) expect(s.text).toContain('Andheri Store');
    expect(JSON.stringify(slice)).not.toMatch(/Bandra|st_ban|evt_|evidence/);
  });
});

describe('GET /api/retail/stores/:storeId/insights', () => {
  it('own store only: a sibling store of the same retailer is 404; other roles are 403', async () => {
    const s = await buildScenarioWorld();
    await held(s);
    const own = await s.get('/api/retail/stores/sc_A/insights?days=7', 'radmin_scA');
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      store_id: 'sc_A',
      period: { days: 7 },
      demo_history: { included: true },
      missed: expect.any(Array),
      fill_rate: expect.any(Array),
      refusals: expect.any(Object),
      suggestions: expect.any(Array),
    });
    expect(JSON.stringify(own.body)).not.toMatch(/evidence|"ids"|customer|latitude|longitude|sc_B/);

    // sc_B belongs to the same retailer (rtl_A) and has its own Retail Admin: still 404.
    expect((await s.get('/api/retail/stores/sc_B/insights', 'radmin_scA')).status).toBe(404);
    expect((await s.get('/api/retail/stores/sc_A/insights', 'radmin_scB')).status).toBe(404);
    expect((await s.get('/api/retail/stores/sc_A/insights', 'admin_a')).status).toBe(403);
    expect((await s.get('/api/retail/stores/sc_A/insights?days=3', 'radmin_scA')).status).toBe(400);
  });
});
