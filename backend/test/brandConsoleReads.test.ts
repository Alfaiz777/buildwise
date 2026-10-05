/**
 * Change 16, UI-3: the read-only additions behind the Brand Console — the journey's outcome
 * and reservation status history on the conversation detail, the brand-only reservation
 * row fields, the synthetic flag, and GET /api/brand/settings (no secrets).
 */
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CsvRetailFileParser } from '../src/adapters/retail/csvRetailFileParser.js';
import { DEFAULT_COMMERCE_FIXTURE } from '../src/adapters/commerce/mockCommerceProvider.js';
import { statusHistory } from '../src/application/conversationQueryService.js';
import { REQUIRED_COLUMNS, validateRetailRows } from '../src/domain/retailRows.js';
import type { ReservationRecord } from '../src/ports/reservations.js';
import { bearer, buildTestWorld } from './helpers.js';
import { buildScenarioWorld, type ScenarioWorld } from './scenarioWorld.js';

const patch = (s: ScenarioWorld, id: string, body: Record<string, unknown>) =>
  request(s.world.app).patch(`/api/reservations/${id}`).set('Authorization', bearer('radmin_scA')).send(body);

async function held(s: ScenarioWorld, ref = 'c1') {
  await s.startFromStore(ref, 'hi');
  await s.share(ref);
  const hold = await s.tap(ref, 'hold:sc_A');
  const id = hold.body.decision.executed_action.reservation_id as string;
  const r = s.world.reservations.reservations.find((x) => x.reservationId === id)!;
  return { id, pickupCode: r.pickupCode, conversationId: hold.body.conversation_id as string };
}

describe('conversation detail: journey outcome and reservation status history', () => {
  it('a completed pickup shows every status step in order and the OFFLINE outcome with its value', async () => {
    const s = await buildScenarioWorld();
    const { id, pickupCode, conversationId } = await held(s);
    await patch(s, id, { status: 'CONFIRMED', expected_current_status: 'PENDING' });
    await patch(s, id, { status: 'READY', expected_current_status: 'CONFIRMED' });
    await patch(s, id, { status: 'CUSTOMER_ARRIVED', expected_current_status: 'READY' });
    await patch(s, id, { status: 'COMPLETED', expected_current_status: 'CUSTOMER_ARRIVED', pickup_code: pickupCode });

    const detail = await s.get(`/api/brand/conversations/${conversationId}`);
    expect(detail.status).toBe(200);
    const reservation = detail.body.recommendations.find((r: { reservation: unknown }) => r.reservation).reservation;
    expect(reservation).toMatchObject({
      reservation_id: id,
      status: 'COMPLETED',
      quantity: 1,
      product_title: 'Vitamin C Glow Serum',
      variant_title: '30 ml',
    });
    expect(reservation.status_history.map((h: { status: string }) => h.status)).toEqual([
      'PENDING',
      'CONFIRMED',
      'READY',
      'CUSTOMER_ARRIVED',
      'COMPLETED',
    ]);
    expect(detail.body.outcomes).toEqual([
      expect.objectContaining({
        purchase_type: 'OFFLINE',
        evidence: 'RESERVATION_COMPLETED',
        store_id: 'sc_A',
        store_name: 'Colaba Store',
        reservation_id: id,
        value: 795,
      }),
    ]);
    expect(detail.body.demo_history).toBe(false);
  });

  it('a refusal records who and why, but never the internal note', async () => {
    const s = await buildScenarioWorld();
    const { id, conversationId } = await held(s);
    await patch(s, id, {
      status: 'CANCELLED',
      expected_current_status: 'PENDING',
      cancel_reason: 'OTHER',
      cancel_note: 'internal: shelf mislabelled',
    });
    const detail = await s.get(`/api/brand/conversations/${conversationId}`);
    const history = detail.body.recommendations.find((r: { reservation: unknown }) => r.reservation).reservation
      .status_history;
    expect(history.at(-1)).toMatchObject({ status: 'CANCELLED', by: 'RETAILER', reason: 'OTHER' });
    expect(JSON.stringify(detail.body)).not.toContain('shelf mislabelled');
    expect(detail.body.outcomes).toEqual([]); // no purchase yet; NONE only after the attribution window
  });

  it('statusHistory: an expired hold ends at its expiry time', () => {
    const r = {
      createdAt: '2026-10-05T10:00:00.000Z',
      confirmedAt: '2026-10-05T10:02:00.000Z',
      readyAt: null,
      customerArrivedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      status: 'EXPIRED',
      expiresAt: '2026-10-05T10:20:00.000Z',
    } as unknown as ReservationRecord;
    expect(statusHistory(r)).toEqual([
      { status: 'PENDING', at: '2026-10-05T10:00:00.000Z' },
      { status: 'CONFIRMED', at: '2026-10-05T10:02:00.000Z' },
      { status: 'EXPIRED', at: '2026-10-05T10:20:00.000Z' },
    ]);
  });
});

describe('reservation rows: brand-only fields', () => {
  it('the brand row links its conversation and image; the store row never gets the conversation', async () => {
    const s = await buildScenarioWorld();
    const { id, conversationId } = await held(s);
    const brand = await s.get('/api/reservations');
    expect(brand.body.reservations.find((r: { reservation_id: string }) => r.reservation_id === id)).toMatchObject({
      conversation_id: conversationId,
      demo_history: false,
      image_url: expect.anything(),
    });
    const store = await s.get('/api/reservations', 'radmin_scA');
    const row = store.body.reservations.find((r: { reservation_id: string }) => r.reservation_id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('conversation_id');
    expect(row).toHaveProperty('why_here'); // UI-4: the store's own, store-safe reason instead
    const one = await s.get(`/api/reservations/${id}`, 'radmin_scA');
    expect(one.body).not.toHaveProperty('conversation_id');
  });

  it('synthetic history is flagged on conversation and reservation rows', async () => {
    const s = await buildScenarioWorld();
    const { id, conversationId } = await held(s);
    s.world.conversations.conversations.find((c) => c.conversationId === conversationId)!.demoHistory = true;
    s.world.reservations.reservations.find((r) => r.reservationId === id)!.demoHistory = true;
    const list = await s.get('/api/brand/conversations');
    expect(
      list.body.conversations.find((c: { conversation_id: string }) => c.conversation_id === conversationId),
    ).toMatchObject({ demo_history: true });
    const rows = await s.get('/api/reservations');
    expect(rows.body.reservations.find((r: { reservation_id: string }) => r.reservation_id === id)).toMatchObject({
      demo_history: true,
    });
  });
});

describe('GET /api/brand/settings (read-only)', () => {
  it('returns exactly the Settings fields, resolved, with no secrets, number or user data', async () => {
    const world = await buildTestWorld();
    const brand = world.brands.brands.find((b) => b.brandId === 'brand_A')!;
    brand.settings = {
      ...brand.settings,
      messaging: { display_name: 'Brand A', whatsapp_number: '+91 98765 43210', powered_by_footer: false },
      retail_freshness_hours: 12,
      online_store: { product_url_template: 'https://a.test/p/{product_id}', delivery_days: '2-3' },
      reservation_policy: { extended_radius_km: 20 },
      outcome_policy: { attribution_window_minutes: 10 },
      follow_up_policy: { inactivity_minutes: 1, types: { CART_ABANDONMENT: { enabled: true, delay_minutes: 2 } } },
      connections: { shopify: { admin_token: 'shpat_secret_value' } },
    };
    const res = await request(world.app).get('/api/brand/settings').set('Authorization', bearer('admin_a'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'allowed_storefront_origins',
        'attribution_window_minutes',
        'brand_id',
        'channel',
        'follow_up',
        'fulfilment',
        'messaging',
        'retail_freshness_hours',
      ].sort(),
    );
    expect(Object.keys(res.body.messaging).sort()).toEqual(
      ['display_name', 'handoff_enabled', 'logo_url', 'powered_by_footer'].sort(),
    );
    expect(res.body).toMatchObject({
      brand_id: 'brand_A',
      messaging: { display_name: 'Brand A', powered_by_footer: false },
      retail_freshness_hours: 12,
      attribution_window_minutes: 10,
      channel: { mode: 'SIMULATOR' },
      fulfilment: { home_delivery: true, delivery_days: '2–3', radius_km: 10, extended_radius_km: 20 },
    });
    expect(res.body.follow_up.inactivity_minutes).toBe(1);
    expect(res.body.follow_up.types).toContainEqual({
      type: 'CART_ABANDONMENT',
      enabled: true,
      delay_minutes: 2,
      priority: 'NORMAL',
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/98765|shpat|secret|admin_token|@/);
  });

  it('empty settings resolve to the documented defaults; other roles are refused', async () => {
    const world = await buildTestWorld();
    world.brands.brands.find((b) => b.brandId === 'brand_A')!.settings = {};
    const res = await request(world.app).get('/api/brand/settings').set('Authorization', bearer('admin_a'));
    expect(res.body).toMatchObject({
      messaging: { powered_by_footer: true, handoff_enabled: true, logo_url: null },
      retail_freshness_hours: 24,
      attribution_window_minutes: 7 * 24 * 60,
      allowed_storefront_origins: [],
      fulfilment: { home_delivery: false, delivery_days: '4–5', radius_km: 10, extended_radius_km: 25 },
    });
    for (const user of ['platform', 'radmin_A']) {
      const denied = await request(world.app).get('/api/brand/settings').set('Authorization', bearer(user));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).not.toBe('USER_MISCONFIGURED');
    }
  });
});

describe('Network "Download sample CSV"', () => {
  it('uses the canonical columns and imports with no row errors and only catalogue SKUs', () => {
    const file = readFileSync(new URL('../../frontend/public/samples/retail-stock-sample.csv', import.meta.url));
    const parsed = new CsvRetailFileParser().parse(file);
    for (const column of REQUIRED_COLUMNS) expect(parsed.header).toContain(column);
    const result = validateRetailRows(parsed.header, parsed.rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.errors).toEqual([]);
    expect(parsed.rows.length).toBeGreaterThan(20);
    const catalogue = JSON.stringify(DEFAULT_COMMERCE_FIXTURE);
    for (const row of parsed.rows) expect(catalogue).toContain(`"${row.values.sku}"`);
  });
});
