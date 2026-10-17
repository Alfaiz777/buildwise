/**
 * Change 19 on the Firestore emulator: the REAL FirestoreStoreSaleRepository against real
 * retailInventory documents. A walk-in sale deducts stock in one transaction, never takes a unit
 * held for a Qwikspot shopper, two sales racing for the last unit cannot both win, and a void
 * gives the stock back once. Run from the repo root: npm run test:emulator
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirestoreStoreSaleRepository } from '../../src/adapters/firestore/storeSaleRepository.js';
import { inventoryIdFor } from '../../src/adapters/firestore/repositories.js';
import { checkSale } from '../../src/domain/storeSale.js';
import { initFirebase } from '../../src/firebase/admin.js';

const PROJECT = 'demo-qwikspot';
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Emulator tests need FIRESTORE_EMULATOR_HOST (npm run test:emulator)');
}
const BRAND = 'brd_sales_emu';
const STORE = 'st_sales_1';
const { db } = initFirebase(PROJECT, null);
const repo = new FirestoreStoreSaleRepository(db);
const inventory = () => db.collection('brands').doc(BRAND).collection('retailInventory');
const stockRow = async (sku: string) => (await inventory().doc(inventoryIdFor(STORE, sku)).get()).data()!;

async function seed(sku: string, quantity: number, reserved = 0) {
  await inventory()
    .doc(inventoryIdFor(STORE, sku))
    .set({
      inventory_id: inventoryIdFor(STORE, sku),
      brand_id: BRAND,
      store_id: STORE,
      sku,
      canonical_sku: sku,
      variant_id: `var_${sku}`,
      quantity,
      reserved_quantity: reserved,
      offline_price: 349,
      availability_status: 'IN_STOCK',
    });
}

const sale = (sku: string, quantity: number) =>
  repo.record({
    brandId: BRAND,
    storeId: STORE,
    lines: [{ sku, quantity }],
    paymentMethod: 'CASH',
    currency: 'INR',
    createdBy: 'radmin_emu',
    titles: new Map([[sku, { productTitle: 'Serum', variantTitle: '30 ml' }]]),
    at: new Date().toISOString(),
    check: checkSale,
  });

async function clear() {
  for (const name of ['retailInventory', 'storeSales', 'stockMovements', 'storeSaleCounters']) {
    const snap = await db.collection('brands').doc(BRAND).collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

beforeAll(clear);
afterAll(clear);

describe('walk-in sales on Firestore', () => {
  it('deducts the stock and writes the invoice, its movement and the reason in one transaction', async () => {
    await seed('EMU-A', 5);
    const r = await sale('EMU-A', 2);
    expect(r.status).toBe('RECORDED');
    if (r.status !== 'RECORDED') return;
    expect(r.sale.invoiceNumber).toBe('INV-000001');
    expect(await stockRow('EMU-A')).toMatchObject({ quantity: 3, last_change_reason: 'IN_STORE_SALE' });
    expect((await repo.get(BRAND, r.sale.saleId))?.total).toBe(698);
    const moves = await repo.movements(BRAND, STORE, { sku: 'EMU-A', limit: 10 });
    expect(moves.map((m) => [m.delta, m.quantityAfter, m.reason])).toEqual([[-2, 3, 'IN_STORE_SALE']]);
    expect((await sale('EMU-A', 1)).status === 'RECORDED' && 'INV-000002').toBeTruthy();
  });

  it('never takes a unit held for a Qwikspot shopper; nothing is written when refused', async () => {
    await seed('EMU-B', 3, 2);
    const r = await sale('EMU-B', 2);
    expect(r).toMatchObject({ status: 'REJECTED', check: { code: 'NOT_ENOUGH_STOCK' } });
    expect(await stockRow('EMU-B')).toMatchObject({ quantity: 3, reserved_quantity: 2 });
  });

  it('two sales racing for the last unit: exactly one wins', async () => {
    await seed('EMU-C', 1);
    const results = await Promise.all([sale('EMU-C', 1), sale('EMU-C', 1)]);
    expect(results.filter((r) => r.status === 'RECORDED')).toHaveLength(1);
    expect(await stockRow('EMU-C')).toMatchObject({ quantity: 0 });
  });

  it('a void gives the stock back once', async () => {
    await seed('EMU-D', 4);
    const r = await sale('EMU-D', 3);
    if (r.status !== 'RECORDED') throw new Error('not recorded');
    const args = {
      brandId: BRAND,
      storeId: STORE,
      saleId: r.sale.saleId,
      by: 'radmin_emu',
      reason: 'Entered twice',
      at: new Date().toISOString(),
      allowed: () => true,
    };
    expect((await repo.void(args)).status).toBe('VOIDED');
    expect(await stockRow('EMU-D')).toMatchObject({ quantity: 4, last_change_reason: 'SALE_VOIDED' });
    expect((await repo.void(args)).status).toBe('ALREADY_VOIDED');
    expect(await stockRow('EMU-D')).toMatchObject({ quantity: 4 });
  });
});
