import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  conversionByAction,
  fillRate,
  funnel,
  readingFor,
  suggestions,
  unmetDemand,
  weekdayPanel,
  weekdayReading,
  type InsightCatalog,
  type InsightRows,
} from '../src/domain/insights.js';
import { bearer } from './helpers.js';
import { buildScenarioWorld } from './scenarioWorld.js';

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
  variants: [
    { variantId: 'v30', sku: 'SERUM-30', label: 'Vitamin C Glow Serum 30 ml' },
    { variantId: 'v50', sku: 'SERUM-50', label: 'Vitamin C Glow Serum 50 ml' },
  ],
  defaultTimezone: 'Asia/Kolkata',
};

// 2026-10-03 is a Saturday. 20:00 UTC on Friday is already Saturday 01:30 in Mumbai.
const SAT = '2026-10-03T06:00:00.000Z';
const FRI_LATE_UTC = '2026-10-02T20:00:00.000Z';
const TUE = '2026-09-29T06:00:00.000Z';
const WED = '2026-09-30T06:00:00.000Z';

let n = 0;
const lookup = (at: string, kind: 'PROPOSED' | 'UNMET_DEMAND', over: Partial<InsightRows['lookups'][number]> = {}) => ({
  eventId: `evt_${++n}`,
  timestamp: at,
  kind,
  variantId: 'v30',
  sku: 'SERUM-30',
  area: 'andheri',
  excluded: kind === 'UNMET_DEMAND' ? [{ storeId: 'st_and', reason: 'OUT_OF_STOCK' }] : [],
  nearestStoreId: 'st_and',
  nearestReason: kind === 'UNMET_DEMAND' ? 'OUT_OF_STOCK' : null,
  timezone: 'Asia/Kolkata',
  ...over,
});

const empty = (): InsightRows => ({
  intents: [],
  conversations: [],
  recommendations: [],
  lookups: [],
  reservations: [],
  outcomes: [],
});

describe('insight calculations (Change 13, F8) on fixed datasets', () => {
  it('funnel counts every stage and outcomes by purchase type', () => {
    const rows: InsightRows = {
      ...empty(),
      intents: [
        { intentId: 'i1', detectedAt: TUE, followUpSentAt: TUE },
        { intentId: 'i2', detectedAt: TUE, followUpSentAt: null },
      ],
      conversations: [{ conversationId: 'c1', startedAt: TUE }],
      lookups: [lookup(TUE, 'PROPOSED'), lookup(TUE, 'UNMET_DEMAND')],
      reservations: [
        {
          reservationId: 'r1',
          storeId: 'st_and',
          variantId: 'v30',
          status: 'COMPLETED',
          createdAt: TUE,
          cancelledBy: null,
          cancelReason: null,
        },
        {
          reservationId: 'r2',
          storeId: 'st_and',
          variantId: 'v30',
          status: 'EXPIRED',
          createdAt: TUE,
          cancelledBy: null,
          cancelReason: null,
        },
      ],
      outcomes: [
        { outcomeId: 'o1', purchaseType: 'OFFLINE', aiRecommendationId: 'rec1', timestamp: TUE },
        { outcomeId: 'o2', purchaseType: 'NONE', aiRecommendationId: 'rec2', timestamp: TUE },
      ],
    };
    expect(funnel(rows)).toEqual({
      intents: 2,
      follow_ups_sent: 1,
      conversations: 1,
      store_recommendations: 1,
      reservations: 2,
      completed: 1,
      outcomes: { ONLINE: 0, OFFLINE: 1, ALTERNATIVE: 0, NONE: 1 },
    });
  });

  it('conversion by action: intended vs recorded purchase type (docs/04 §16.1)', () => {
    const rows: InsightRows = {
      ...empty(),
      recommendations: [
        { recommendationId: 'rec1', action: 'STORE_RESERVATION', proposedAt: TUE },
        { recommendationId: 'rec2', action: 'STORE_RESERVATION', proposedAt: TUE },
        { recommendationId: 'rec3', action: 'ONLINE_PURCHASE', proposedAt: TUE },
        { recommendationId: 'rec4', action: 'NO_ACTION', proposedAt: TUE },
      ],
      outcomes: [
        { outcomeId: 'o1', purchaseType: 'OFFLINE', aiRecommendationId: 'rec1', timestamp: TUE },
        { outcomeId: 'o2', purchaseType: 'NONE', aiRecommendationId: 'rec2', timestamp: TUE },
        { outcomeId: 'o3', purchaseType: 'ONLINE', aiRecommendationId: 'rec3', timestamp: TUE },
        { outcomeId: 'o4', purchaseType: 'ONLINE', aiRecommendationId: 'rec4', timestamp: TUE },
      ],
    };
    expect(conversionByAction(rows)).toEqual([
      {
        action: 'STORE_RESERVATION',
        intended: ['OFFLINE'],
        outcomes: 2,
        recorded: { OFFLINE: 1, NONE: 1 },
        converted: 1,
        rate_pct: 50,
      },
      { action: 'NO_ACTION', intended: null, outcomes: 1, recorded: { ONLINE: 1 }, converted: 0, rate_pct: null },
      {
        action: 'ONLINE_PURCHASE',
        intended: ['ONLINE'],
        outcomes: 1,
        recorded: { ONLINE: 1 },
        converted: 1,
        rate_pct: 100,
      },
    ]);
  });

  it('weekdays are taken in the store timezone (Friday 20:00 UTC counts as Saturday in Mumbai)', () => {
    const rows = { ...empty(), lookups: [lookup(FRI_LATE_UTC, 'UNMET_DEMAND')] };
    const days = weekdayPanel(rows, catalog);
    expect(days.find((d) => d.weekday === 'saturday')).toMatchObject({ lookups: 1, no_store: 1, no_store_pct: 100 });
    expect(days.find((d) => d.weekday === 'friday')).toMatchObject({ lookups: 0 });
    expect(unmetDemand(rows, catalog)[0]).toMatchObject({
      sku: 'SERUM-30',
      area: 'andheri',
      weekday: 'saturday',
      count: 1,
    });
  });

  it('the reading: a Saturday spike with no stock reads as an availability problem', () => {
    const lookups = [
      ...Array.from({ length: 6 }, (_, i) => lookup(SAT, i < 3 ? 'UNMET_DEMAND' : 'PROPOSED')),
      lookup(TUE, 'PROPOSED'),
      lookup(TUE, 'PROPOSED'),
      lookup(WED, 'PROPOSED'),
      lookup(WED, 'PROPOSED'),
    ];
    const reading = weekdayReading({ ...empty(), lookups }, catalog);
    expect(reading).toMatchObject({
      kind: 'AVAILABILITY_PROBLEM',
      peak_weekday: 'saturday',
      peak_no_store_pct: 50,
      other_no_store_pct: 0,
    });
    // Other days average (2+2+0+0+0+0)/6 ≈ 0.67 → 9.0×.
    expect(reading.text).toBe(
      "Saturday lookups for Vitamin C Glow Serum 30 ml were 9.0× the other days' average, but 50% found no store with stock (other days: 0%). This looks like an availability problem, not a demand problem.",
    );
  });

  it('the reading: a spike with stock is a demand peak; an even week is steady; few lookups → not enough data', () => {
    const peak = weekdayPanel(
      { ...empty(), lookups: [...Array.from({ length: 6 }, () => lookup(SAT, 'PROPOSED')), lookup(TUE, 'PROPOSED')] },
      catalog,
      'SERUM-30',
    );
    expect(readingFor('SERUM-30', peak, catalog).kind).toBe('DEMAND_PEAK');
    const even = weekdayPanel(
      {
        ...empty(),
        lookups: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map(
          (d) => lookup(`${d}T06:00:00.000Z`, 'PROPOSED'),
        ),
      },
      catalog,
      'SERUM-30',
    );
    expect(readingFor('SERUM-30', even, catalog).kind).toBe('STEADY');
    expect(weekdayReading({ ...empty(), lookups: [lookup(SAT, 'PROPOSED')] }, catalog).kind).toBe('NOT_ENOUGH_DATA');
  });

  it('fill rate per store × weekday, with refusals by reason', () => {
    const rows: InsightRows = {
      ...empty(),
      lookups: [
        lookup(SAT, 'UNMET_DEMAND'),
        lookup(SAT, 'PROPOSED'),
        lookup(TUE, 'PROPOSED', { nearestStoreId: 'st_ban' }),
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
      ],
    };
    expect(fillRate(rows, catalog)).toEqual([
      {
        store_id: 'st_and',
        store_name: 'Andheri Store',
        weekday: 'saturday',
        nearest: 2,
        had_stock: 1,
        fill_pct: 50,
        refusals: { DAMAGED: 1 },
      },
      {
        store_id: 'st_ban',
        store_name: 'Bandra Store',
        weekday: 'tuesday',
        nearest: 1,
        had_stock: 1,
        fill_pct: 100,
        refusals: {},
      },
    ]);
  });

  it('suggestion rules link to the rows behind them', () => {
    const unmet50 = Array.from({ length: 3 }, () => lookup(TUE, 'UNMET_DEMAND', { sku: 'SERUM-50', variantId: 'v50' }));
    const satSpike = [
      ...Array.from({ length: 6 }, (_, i) => lookup(SAT, i < 3 ? 'UNMET_DEMAND' : 'PROPOSED')),
      lookup(TUE, 'PROPOSED'),
      lookup(WED, 'PROPOSED'),
    ];
    const rows: InsightRows = {
      ...empty(),
      lookups: [...unmet50, ...satSpike],
      reservations: ['r1', 'r2'].map((id) => ({
        reservationId: id,
        storeId: 'st_and',
        variantId: 'v30',
        status: 'CANCELLED',
        createdAt: TUE,
        cancelledBy: 'RETAILER',
        cancelReason: 'NOT_ACTUALLY_IN_STOCK',
      })),
    };
    const out = suggestions(rows, catalog, 7);
    // Both SKUs had 3 unmet lookups in Andheri (30 ml on Saturday, 50 ml on Tuesday).
    expect(out.map((s) => s.rule)).toEqual([
      'STOCK_UNMET_AREA',
      'STOCK_UNMET_AREA',
      'RAISE_STOCK_BEFORE_PEAK',
      'REUPLOAD_STOCK',
    ]);
    const fifty = out.find((x) => x.text.includes('50 ml'))!;
    expect(fifty.text).toBe(
      'Vitamin C Glow Serum 50 ml was requested 3 times in Andheri in the last 7 days with no store in stock. Suggested: ask North Retail to stock Andheri Store.',
    );
    expect(fifty.evidence).toEqual({ kind: 'EVENTS', ids: unmet50.map((l) => l.eventId) });
    expect(out[2]!.text).toContain(
      'Andheri Store was the nearest store but out of stock of Vitamin C Glow Serum 30 ml 3 times on Saturdays',
    );
    expect(out[3]!.evidence).toEqual({ kind: 'RESERVATIONS', ids: ['r1', 'r2'] });
    // Below the thresholds nothing is suggested.
    expect(suggestions({ ...empty(), lookups: unmet50.slice(0, 2) }, catalog, 7)).toEqual([]);
  });
});

describe('GET /api/brand/insights (brand-scoped)', () => {
  it('totals match the stored records; another brand sees its own (empty) data; other scopes 403', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    await s.tap('c1', 'hold:sc_A');
    const res = await s.get('/api/brand/insights?days=7');
    expect(res.status).toBe(200);
    expect(res.body.funnel).toMatchObject({
      intents: s.world.intents.intents.filter((i) => i.brandId === 'brand_A').length,
      conversations: 1,
      store_recommendations: 1,
      reservations: 1,
      completed: 0,
    });
    expect(res.body.period).toMatchObject({ days: 7, timezone: 'Asia/Kolkata' });
    expect(res.body.weekday.days).toHaveLength(7);
    const other = await s.get('/api/brand/insights', 'admin_b');
    expect(other.body.funnel).toMatchObject({ intents: 0, reservations: 0 });
    expect((await s.get('/api/brand/insights', 'radmin_scA')).status).toBe(403);
    expect((await s.get('/api/brand/insights?days=3')).status).toBe(400);
    expect(
      (await request(s.world.app).get('/api/brand/insights').set('Authorization', bearer('platform'))).status,
    ).toBe(403);
  });
});
