import { describe, expect, it } from 'vitest';
import { generateDemoHistory, prng, type DemoHistoryInput } from '../src/application/demoHistory.js';
import { suggestions, weekdayReading, type InsightCatalog, type InsightRows } from '../src/domain/insights.js';
import { ACTIVE_RESERVATION_STATUSES } from '../src/domain/reservationStatus.js';

const HOURS = {
  timezone: 'Asia/Kolkata',
  monday: '10:00-21:00',
  tuesday: '10:00-21:00',
  wednesday: '10:00-21:00',
  thursday: '10:00-21:00',
  friday: '10:00-21:00',
  saturday: '10:00-22:00',
  sunday: '11:00-20:00',
};
const input = (seed = 42): DemoHistoryInput => ({
  seed,
  now: new Date('2026-10-07T06:30:00.000Z'),
  brandId: 'brd_demo',
  days: 28,
  stores: [
    {
      storeId: 'st_north_1',
      storeName: 'Bandra Store',
      city: 'Mumbai',
      address: 'Hill Road, Bandra West, Mumbai 400050',
      retailerId: 'rtl_north',
      latitude: 19.0544,
      longitude: 72.8267,
      storeHours: HOURS,
    },
    {
      storeId: 'st_north_2',
      storeName: 'Andheri Store',
      city: 'Mumbai',
      address: 'Lokhandwala Complex, Andheri West, Mumbai 400053',
      retailerId: 'rtl_north',
      latitude: 19.1364,
      longitude: 72.8296,
      storeHours: HOURS,
    },
    {
      storeId: 'st_north_3',
      storeName: 'Powai Store',
      city: 'Mumbai',
      address: 'Hiranandani Gardens, Powai, Mumbai 400076',
      retailerId: 'rtl_north',
      latitude: 19.1176,
      longitude: 72.906,
      storeHours: { ...HOURS, sunday: '' },
    },
  ],
  serum30: {
    variantId: 'var_2001',
    productId: 'prd_1001',
    productTitle: 'Vitamin C Glow Serum',
    title: '30 ml',
    sku: 'DBC-VCSERUM-30',
    canonicalSku: 'DBC-VCSERUM-30',
    price: 795,
    currency: 'INR',
  },
  serum50: {
    variantId: 'var_2002',
    productId: 'prd_1001',
    productTitle: 'Vitamin C Glow Serum',
    title: '50 ml',
    sku: 'DBC-VCSERUM-50',
    canonicalSku: 'DBC-VCSERUM-50',
    price: 1195,
    currency: 'INR',
  },
});

const catalog: InsightCatalog = {
  stores: [
    {
      storeId: 'st_north_1',
      storeName: 'Bandra Store',
      locality: 'bandra',
      retailerName: 'North Retail',
      timezone: 'Asia/Kolkata',
    },
    {
      storeId: 'st_north_2',
      storeName: 'Andheri Store',
      locality: 'andheri',
      retailerName: 'North Retail',
      timezone: 'Asia/Kolkata',
    },
    {
      storeId: 'st_north_3',
      storeName: 'Powai Store',
      locality: 'powai',
      retailerName: 'North Retail',
      timezone: 'Asia/Kolkata',
    },
  ],
  variants: [
    { variantId: 'var_2001', sku: 'DBC-VCSERUM-30', label: 'Vitamin C Glow Serum 30 ml' },
    { variantId: 'var_2002', sku: 'DBC-VCSERUM-50', label: 'Vitamin C Glow Serum 50 ml' },
  ],
  defaultTimezone: 'Asia/Kolkata',
};

function rowsOf(h: ReturnType<typeof generateDemoHistory>): InsightRows {
  return {
    intents: h.intents.map((i) => ({
      intentId: i.intentId,
      detectedAt: i.detectedAt,
      followUpSentAt: i.followUp?.sentAt ?? null,
    })),
    conversations: h.conversations.map((c) => ({ conversationId: c.conversationId, startedAt: c.startedAt })),
    recommendations: h.recommendations.map((r) => ({
      recommendationId: r.recommendationId,
      action: r.action,
      proposedAt: r.proposedAt,
    })),
    lookups: h.events
      .filter((e) => e.eventType === 'STORE_RECOMMENDATION')
      .map((e) => {
        const p = e.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        return {
          eventId: e.eventId,
          timestamp: e.timestamp,
          kind: p.kind,
          variantId: p.variant_id,
          sku: p.sku,
          area: p.area?.value ?? null,
          excluded: (p.excluded ?? []).map((x: { store_id: string; reason: string }) => ({
            storeId: x.store_id,
            reason: x.reason,
          })),
          nearestStoreId: p.nearest_store_id ?? null,
          nearestReason: p.nearest_reason ?? null,
          timezone: p.timezone ?? null,
        };
      }),
    reservations: h.reservations.map((r) => ({
      reservationId: r.reservationId,
      storeId: r.storeId,
      variantId: r.variantId,
      status: r.status,
      createdAt: r.createdAt,
      cancelledBy: r.cancelledBy,
      cancelReason: r.cancelReason,
    })),
    outcomes: h.outcomes.map((o) => ({
      outcomeId: o.outcomeId,
      purchaseType: o.purchaseType,
      aiRecommendationId: o.aiRecommendationId,
      timestamp: o.timestamp,
    })),
  };
}

describe('synthetic demo history (Change 13, F9)', () => {
  it('is deterministic for a fixed seed and changes with the seed', () => {
    expect(generateDemoHistory(input())).toEqual(generateDemoHistory(input()));
    expect(generateDemoHistory(input(7))).not.toEqual(generateDemoHistory(input()));
    const r = prng(1);
    expect([r(), r()]).toEqual([
      prng(1)(),
      (() => {
        const x = prng(1);
        x();
        return x();
      })(),
    ]);
  });

  it('uses only synthetic customers, every journey has at most one Outcome, nothing is left active or in the future', () => {
    const h = generateDemoHistory(input());
    const json = JSON.stringify(h);
    expect(json).not.toMatch(/@|\+91|"phone"|"email"/); // no contact details
    for (const id of [...h.intents.map((i) => i.customerId), ...h.reservations.map((r) => r.customerId)]) {
      expect(id).toMatch(/^hist:hist_\d{2}$/);
    }
    const keys = h.outcomes.map((o) => o.journeyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(h.reservations.every((r) => !ACTIVE_RESERVATION_STATUSES.includes(r.status))).toBe(true);
    const now = input().now.toISOString();
    expect([...h.outcomes.map((o) => o.timestamp), ...h.events.map((e) => e.timestamp)].every((t) => t <= now)).toBe(
      true,
    );
    // Reservations go through every terminal status, refusals carry reasons.
    expect(new Set(h.reservations.map((r) => r.status))).toEqual(new Set(['COMPLETED', 'CANCELLED', 'EXPIRED']));
    expect(
      h.reservations
        .filter((r) => r.status === 'CANCELLED')
        .every((r) => r.cancelledBy === 'RETAILER' && r.cancelReason),
    ).toBe(true);
    expect(new Set(h.outcomes.map((o) => o.purchaseType))).toEqual(new Set(['OFFLINE', 'ONLINE', 'NONE']));
    expect(h.events.some((e) => e.eventType === 'ORDER_CREATED' && e.payload.attributed_by === 'QS_REF')).toBe(true);
    expect(h.events.some((e) => e.eventType === 'ORDER_CREATED' && e.payload.attributed_by === null)).toBe(true);
  });

  it('shows the intended pattern through the live insight rules', () => {
    const rows = rowsOf(generateDemoHistory(input()));
    const reading = weekdayReading(rows, catalog);
    expect(reading).toMatchObject({ kind: 'AVAILABILITY_PROBLEM', sku: 'DBC-VCSERUM-30', peak_weekday: 'saturday' });
    expect((reading as { ratio: number }).ratio).toBeGreaterThanOrEqual(1.5);
    const rules = suggestions(rows, catalog, 28);
    expect(
      rules.some(
        (s) =>
          s.rule === 'STOCK_UNMET_AREA' &&
          s.text.startsWith('Vitamin C Glow Serum 50 ml') &&
          s.text.includes('Andheri'),
      ),
    ).toBe(true);
    expect(rules.some((s) => s.rule === 'RAISE_STOCK_BEFORE_PEAK' && s.text.startsWith('Andheri Store'))).toBe(true);
    // Bandra never runs out.
    expect(rows.lookups.some((l) => l.nearestStoreId === 'st_north_1' && l.nearestReason === 'OUT_OF_STOCK')).toBe(
      false,
    );
  });
});
