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
