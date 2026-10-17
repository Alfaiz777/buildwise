/**
 * Change 19: in-store (walk-in) sales. The Store Console records an invoice; the sold units leave
 * the store's stock at once (atomically with Qwikspot holds), the stock row says why it changed,
 * the AI's stock tool sees it, and the Brand Console sees every store's walk-in sales beside its
 * Qwikspot pickups. No customer data on an invoice.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkSale } from '../src/domain/storeSale.js';
import { bearer } from './helpers.js';
import { buildScenarioWorld, SCENARIO_NOW, V1, V2, type ScenarioWorld } from './scenarioWorld.js';

const sell = (s: ScenarioWorld, body: object, user = 'radmin_scA', store = 'sc_A') =>
  request(s.world.app).post(`/api/retail/stores/${store}/sales`).set('Authorization', bearer(user)).send(body);
const voidSale = (s: ScenarioWorld, saleId: string, reason = 'Entered twice', user = 'radmin_scA', store = 'sc_A') =>
  request(s.world.app)
    .post(`/api/retail/stores/${store}/sales/${saleId}/void`)
    .set('Authorization', bearer(user))
    .send({ reason });

describe('checkSale (pure)', () => {
  const stock = [
    { sku: 'A', canonicalSku: 'A', variantId: 'va', quantity: 5, reservedQuantity: 2, offlinePrice: 349 },
    { sku: 'B', canonicalSku: 'B', variantId: 'vb', quantity: 1, reservedQuantity: 0, offlinePrice: 99.5 },
  ];
  it('prices from the store, merges a SKU listed twice, totals', () => {
    const r = checkSale(
      [
        { sku: 'A', quantity: 1 },
        { sku: 'B', quantity: 1 },
        { sku: 'A', quantity: 2 },
      ],
      stock,
    );
    expect(r).toMatchObject({ ok: true, units: 4, total: 1146.5 });
    if (r.ok)
      expect(r.lines.map((l) => [l.sku, l.quantity, l.lineTotal])).toEqual([
        ['A', 3, 1047],
        ['B', 1, 99.5],
      ]);
  });
  it('never sells units held for Qwikspot shoppers', () => {
    expect(checkSale([{ sku: 'A', quantity: 4 }], stock)).toEqual({
      ok: false,
      code: 'NOT_ENOUGH_STOCK',
      lines: [{ sku: 'A', requested: 4, available: 3, held: 2 }],
    });
  });
  it('rejects unknown SKUs, empty invoices and bad quantities', () => {
    expect(checkSale([{ sku: 'Z', quantity: 1 }], stock)).toMatchObject({
      ok: false,
      code: 'UNKNOWN_SKU',
      skus: ['Z'],
    });
    expect(checkSale([], stock)).toMatchObject({ ok: false, code: 'INVALID_SALE' });
    expect(checkSale([{ sku: 'A', quantity: 1.5 }], stock)).toMatchObject({ ok: false, code: 'INVALID_SALE' });
  });
});

describe('Store Console — recording a walk-in sale', () => {
  let s: ScenarioWorld;
  beforeEach(async () => {
    s = await buildScenarioWorld();
  });

  it('deducts the stock at once, numbers the invoice, says why the stock changed — and carries no customer', async () => {
    const sku = s.stock('sc_A').sku;
    const before = s.stock('sc_A').quantity;
    const res = await sell(s, { lines: [{ sku, quantity: 2 }], payment_method: 'UPI' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      invoice_number: 'INV-000001',
      units: 2,
      status: 'RECORDED',
      payment_method: 'UPI',
      lines: [
        expect.objectContaining({ sku, quantity: 2, product_title: 'Vitamin C Glow Serum', variant_title: '30 ml' }),
      ],
    });
    expect(res.body.total).toBe(res.body.lines[0].unit_price * 2);
    expect(JSON.stringify(res.body)).not.toMatch(/phone|email|customer|radmin/i);
    expect(s.stock('sc_A').quantity).toBe(before - 2);
    expect(s.stock('sc_A')).toMatchObject({ lastChangeReason: 'IN_STORE_SALE' });
    const second = await sell(s, { lines: [{ sku, quantity: 1 }], payment_method: 'CASH' });
    expect(second.body.invoice_number).toBe('INV-000002');

    // The store's stock page shows why each row last changed; its history lists the sale.
    const inv = await s.get('/api/retail/stores/sc_A/inventory', 'radmin_scA');
    expect(inv.body.items.find((i: { sku: string }) => i.sku === sku)).toMatchObject({
      quantity: before - 3,
      last_change_reason: 'IN_STORE_SALE',
    });
    const history = await s.get(`/api/retail/stores/sc_A/stock-history?sku=${sku}`, 'radmin_scA');
    expect(history.body.movements.map((m: { delta: number; reason: string }) => [m.delta, m.reason])).toEqual([
      [-1, 'IN_STORE_SALE'],
      [-2, 'IN_STORE_SALE'],
    ]);
    // Audited, with the store user as the actor.
    expect(s.world.audit.brandEvents.filter((e) => e.action === 'STORE_SALE_RECORDED')).toHaveLength(2);
  });

  it('never sells a unit held for a Qwikspot shopper on their way', async () => {
    const sku = s.stock('sc_A').sku; // 8 on hand
    await s.startFromStore('held', 'hi');
    await s.share('held');
    await s.tap('held', 'hold:sc_A');
    expect(s.stock('sc_A').reservedQuantity).toBe(1);
    const res = await sell(s, { lines: [{ sku, quantity: 8 }], payment_method: 'CASH' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'NOT_ENOUGH_STOCK' });
    expect(res.body.error.message).toMatch(/7 available \(1 held for Qwikspot shoppers\)/);
    expect(s.stock('sc_A').quantity).toBe(8); // nothing written
    expect((await sell(s, { lines: [{ sku, quantity: 7 }], payment_method: 'CASH' })).status).toBe(201);
    expect(s.stock('sc_A')).toMatchObject({ quantity: 1, reservedQuantity: 1 }); // the held unit stays held
  });

  it('a walk-in sale and a hold can never both take the last unit', async () => {
    const sku = s.stock('sc_A').sku;
    const all = s.stock('sc_A').quantity;
    await sell(s, { lines: [{ sku, quantity: all - 1 }], payment_method: 'CASH' }); // 1 left
    await s.startFromStore('race', 'hi');
    await s.share('race');
    const [hold, sale] = await Promise.all([
      s.tap('race', 'hold:sc_A'),
      sell(s, { lines: [{ sku, quantity: 1 }], payment_method: 'CASH' }),
    ]);
    const held = hold.body.decision?.executed_action?.type === 'RESERVATION_CREATED';
    expect(held !== (sale.status === 201)).toBe(true); // exactly one of them
    expect(s.stock('sc_A').quantity - s.stock('sc_A').reservedQuantity).toBe(0);
  });

  it('refuses another store, the Brand Admin, an unknown SKU and a body with a customer field', async () => {
    const sku = s.stock('sc_A').sku;
    expect(
      (await sell(s, { lines: [{ sku, quantity: 1 }], payment_method: 'CASH' }, 'radmin_scA', 'sc_B')).status,
    ).toBe(404);
    expect((await sell(s, { lines: [{ sku, quantity: 1 }], payment_method: 'CASH' }, 'admin_a')).status).toBe(403);
    const unknown = await sell(s, { lines: [{ sku: 'NOPE-1', quantity: 1 }], payment_method: 'CASH' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('UNKNOWN_SKU');
    const withCustomer = await sell(s, {
      lines: [{ sku, quantity: 1 }],
      payment_method: 'CASH',
      customer_phone: '+91 98765 43210',
    });
    expect(withCustomer.status).toBe(400);
    expect((await sell(s, { lines: [{ sku, quantity: 0 }], payment_method: 'CASH' })).status).toBe(400);
  });

  it('voiding gives the stock back once, within 24 hours, with a reason', async () => {
    const sku = s.stock('sc_A').sku;
    const before = s.stock('sc_A').quantity;
    const sale = (await sell(s, { lines: [{ sku, quantity: 2 }], payment_method: 'CARD' })).body;
    expect((await voidSale(s, sale.sale_id, 'x')).status).toBe(400); // a reason of 3+ characters
    const voided = await voidSale(s, sale.sale_id);
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ status: 'VOIDED', void_reason: 'Entered twice' });
    expect(s.stock('sc_A')).toMatchObject({ quantity: before, lastChangeReason: 'SALE_VOIDED' });
    expect((await voidSale(s, sale.sale_id)).body.error.code).toBe('ALREADY_VOIDED');
    // Another store's admin cannot see or void it.
    expect((await voidSale(s, sale.sale_id, 'Not mine', 'radmin_scB', 'sc_B')).status).toBe(404);

    const late = (await sell(s, { lines: [{ sku, quantity: 1 }], payment_method: 'CASH' })).body;
    s.setNow(new Date(SCENARIO_NOW.getTime() + 25 * 3_600_000));
    expect((await voidSale(s, late.sale_id)).body.error.code).toBe('VOID_WINDOW_PASSED');

    // The day's list counts recorded sales only; voided ones are listed, not counted.
    s.setNow(SCENARIO_NOW);
    const list = await s.get('/api/retail/stores/sc_A/sales?days=1', 'radmin_scA');
    expect(list.body.totals).toMatchObject({ invoices: 1, units: 1, voided: 1 });
  });
});

describe('the AI sees the live stock and why it changed', () => {
  it("after a walk-in sale, the agent's stock check reports the count and IN_STORE_SALE", async () => {
    const s = await buildScenarioWorld();
    const sku = s.stock('sc_A').sku;
    await sell(s, { lines: [{ sku, quantity: 1 }], payment_method: 'CASH' });
    await s.startFromStore('ai', 'hi');
    await s.share('ai');
    await s.tap('ai', 'hold:sc_A');
    const calls = s.world.recommendations.recommendations.flatMap((r) => r.trace?.tool_calls ?? []);
    const check = calls.find((c) => c.tool === 'check_store_inventory');
    expect(check?.output_summary).toMatchObject({ last_change_reason: 'IN_STORE_SALE' });
  });

  it("the store's and the brand's Ask Qwikspot packs carry the walk-in sales", async () => {
    const s = await buildScenarioWorld();
    const sku = s.stock('sc_A').sku;
    await sell(s, { lines: [{ sku, quantity: 2 }], payment_method: 'CASH' });
    const principal = {
      scope: 'RETAIL',
      role: 'RETAIL_ADMIN',
      userId: 'radmin_scA',
      email: null,
      brandId: 'brand_A',
      retailerId: 'rtl_A',
      storeId: 'sc_A',
    } as const;
    const store = await s.world.storeAssistant.pack(principal);
    expect(store.walk_in_sales).toMatchObject({ today: { invoices: 1, units: 2 }, period: { invoices: 1, units: 2 } });
    expect(store.stock_attention.every((l) => 'last_change' in l)).toBe(true);
    const brand = await s.world.brandAssistant.pack({
      scope: 'BRAND',
      role: 'BRAND_ADMIN',
      userId: 'admin_a',
      email: null,
      brandId: 'brand_A',
    });
    expect(brand.in_store_sales).toMatchObject({ walk_in: { invoices: 1, units: 2 } });
  });
});

describe('Brand Console — offline sales across stores', () => {
  it('walk-in sales by store and product beside Qwikspot pickups; the Retail Admin cannot read it', async () => {
    const s = await buildScenarioWorld();
    const v1 = s.stock('sc_A', V1).sku;
    const v2 = s.stock('sc_A', V2).sku;
    await sell(s, {
      lines: [
        { sku: v1, quantity: 2 },
        { sku: v2, quantity: 1 },
      ],
      payment_method: 'CASH',
    });
    const voided = (await sell(s, { lines: [{ sku: v1, quantity: 1 }], payment_method: 'CASH' })).body;
    await voidSale(s, voided.sale_id);
    await sell(s, { lines: [{ sku: s.stock('sc_B').sku, quantity: 1 }], payment_method: 'UPI' }, 'radmin_scB', 'sc_B');

    const res = await s.get('/api/brand/sales?days=7');
    expect(res.status).toBe(200);
    expect(res.body.walk_in).toMatchObject({ invoices: 2, units: 4, voided: 1 });
    expect(res.body.by_store.find((r: { store_id: string }) => r.store_id === 'sc_A')).toMatchObject({
      store_name: 'Colaba Store',
      invoices: 1,
      units: 3,
    });
    expect(res.body.by_product[0]).toMatchObject({ sku: v1, units: 3 });
    expect(res.body.recent).toHaveLength(3);
    expect(res.body.qwikspot_pickups).toMatchObject({ pickups: 0 });
    expect(JSON.stringify(res.body)).not.toMatch(/radmin|phone|email/i);
    expect((await s.get('/api/brand/sales?days=7', 'radmin_scA')).status).toBe(403);
    expect((await s.get('/api/brand/sales?days=9')).status).toBe(400);
  });
});
