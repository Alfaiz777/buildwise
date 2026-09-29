import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CsvRetailFileParser } from '../src/adapters/retail/csvRetailFileParser.js';
import { StoreService } from '../src/application/storeService.js';
import { REQUIRED_COLUMNS, validateRetailRows } from '../src/domain/retailRows.js';
import { mapCatalogVariants, matchRetailSku, normalizeSku } from '../src/domain/skuMapping.js';
import { RetailFileFormatError } from '../src/ports/retailFile.js';
import { buildTestWorld } from './helpers.js';

const COLUMNS = [...REQUIRED_COLUMNS, 'pickup_available', 'reservation_available', 'retailer_id'];

const BASE: Record<string, string> = {
  store_id: 'store_A',
  store_name: 'Store A',
  city: 'Mumbai',
  address: 'Hill Road, Bandra',
  latitude: '19.0544',
  longitude: '72.8267',
  'store_hours.timezone': 'Asia/Kolkata',
  'store_hours.monday': '10:00-21:00',
  'store_hours.tuesday': '10:00-21:00',
  'store_hours.wednesday': '10:00-21:00',
  'store_hours.thursday': '10:00-21:00',
  'store_hours.friday': '10:00-21:00',
  'store_hours.saturday': '10:00-22:00',
  'store_hours.sunday': '',
  store_status: 'ACTIVE',
  pickup_available: 'true',
  reservation_available: 'true',
  retailer_id: 'rtl_A',
  sku: 'DBC-VCSERUM-30',
  quantity: '3',
  offline_price: '795',
};

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function csv(rows: Record<string, string>[], columns = COLUMNS): Buffer {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => cell({ ...BASE, ...r }[c] ?? '')).join(','))];
  return Buffer.from(lines.join('\r\n') + '\r\n');
}

const parser = new CsvRetailFileParser();
const validate = (rows: Record<string, string>[], columns?: string[]) => {
  const parsed = parser.parse(csv(rows, columns));
  return validateRetailRows(parsed.header, parsed.rows);
};
const codes = (rows: Record<string, string>[]) => {
  const result = validate(rows);
  if (!result.ok) throw new Error('unexpected file failure');
  return result.errors.map((e) => e.code);
};

describe('CsvRetailFileParser (format only)', () => {
  it('reads header + rows with physical line numbers; handles BOM, CRLF, quotes and blank lines', () => {
    const content = Buffer.from(
      '﻿store_id,address,sku\r\nst_1,"Hill Road, Bandra",A-1\r\n\r\nst_2,"Line ""2""",B-2\r\n',
    );
    const parsed = parser.parse(content);
    expect(parsed.header).toEqual(['store_id', 'address', 'sku']);
    expect(parsed.rows).toEqual([
      { line: 2, values: { store_id: 'st_1', address: 'Hill Road, Bandra', sku: 'A-1' } },
      { line: 4, values: { store_id: 'st_2', address: 'Line "2"', sku: 'B-2' } },
    ]);
  });

  it('rejects an empty or malformed file', () => {
    expect(() => parser.parse(Buffer.from(''))).toThrow(RetailFileFormatError);
    expect(() => parser.parse(Buffer.from('a,b\n"unterminated,1\n'))).toThrow(RetailFileFormatError);
  });
});

describe('retail row validation (docs/08 §6)', () => {
  it('a valid CSV file: rows accepted, store_hours assembled, empty day = closed', () => {
    const result = validate([{}, { sku: 'DBC-MINSPF-50', quantity: '0' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.errors).toEqual([]);
    expect(result.stockRows.map((r) => [r.sku, r.quantity])).toEqual([
      ['DBC-VCSERUM-30', 3],
      ['DBC-MINSPF-50', 0],
    ]);
    expect(result.stores.get('store_A')).toMatchObject({
      storeHours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00', sunday: '' },
      reservationAvailable: true,
      retailerId: 'rtl_A',
    });
  });

  it('missing columns fail the whole file and name each column', () => {
    const result = validate(
      [{}],
      COLUMNS.filter((c) => c !== 'offline_price' && c !== 'store_hours.monday'),
    );
    expect(result).toEqual({ ok: false, missingColumns: ['store_hours.monday', 'offline_price'] });
  });

  it.each([
    ['duplicate rows', [{}, {}], ['DUPLICATE_ROW']],
    ['invalid SKU', [{ sku: 'SERUM 30/ML' }], ['INVALID_SKU']],
    ['unknown store (invalid store_id)', [{ store_id: 'ALL' }], ['INVALID_STORE_ID']],
    ['missing value', [{ city: '' }], ['MISSING_VALUE']],
    ['negative quantity', [{ quantity: '-2' }], ['INVALID_QUANTITY']],
    ['fractional quantity', [{ quantity: '1.5' }], ['INVALID_QUANTITY']],
    ['invalid price', [{ offline_price: 'free' }], ['INVALID_PRICE']],
    ['negative price', [{ offline_price: '-10' }], ['INVALID_PRICE']],
    ['invalid coordinates', [{ latitude: '123.4' }], ['INVALID_COORDINATES']],
    ['invalid store_status', [{ store_status: 'OPEN' }], ['INVALID_STATUS']],
    ['invalid boolean', [{ pickup_available: 'maybe' }], ['INVALID_BOOLEAN']],
    ['invalid timezone "IST"', [{ 'store_hours.timezone': 'IST' }], ['INVALID_TIMEZONE']],
    ['invalid timezone "+05:30"', [{ 'store_hours.timezone': '+05:30' }], ['INVALID_TIMEZONE']],
    ['malformed day "9-5"', [{ 'store_hours.friday': '9-5' }], ['INVALID_HOURS']],
    ['closing before opening "21:00-10:00"', [{ 'store_hours.friday': '21:00-10:00' }], ['INVALID_HOURS']],
  ])('%s → reported, never silent', (_label, rows, expected) => {
    expect(codes(rows)).toEqual(expected);
  });

  it('conflicting store-level values across rows of the same store_id invalidate every row of that store', () => {
    const result = validate([
      {},
      { sku: 'DBC-MINSPF-50', address: 'Another address' },
      { store_id: 'store_B', sku: 'DBC-MINSPF-50' },
    ]);
    if (!result.ok) throw new Error('unexpected');
    expect(result.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'STORE_FIELDS_CONFLICT'],
      [3, 'STORE_FIELDS_CONFLICT'],
    ]);
    expect([...result.stores.keys()]).toEqual(['store_B']);
    expect(result.stockRows.map((r) => r.storeId)).toEqual(['store_B']);
  });
});

describe('SKU mapping (SKU first, then barcode, never name)', () => {
  const catalog = [
    { variantId: 'v1', canonicalSku: 'DBC-VCSERUM-30', barcode: '8906123000014' },
    { variantId: 'v2', canonicalSku: 'DBC-VCSERUM-50', barcode: '8906123000021' },
    { variantId: 'v3', canonicalSku: 'DUP-1', barcode: null },
    { variantId: 'v4', canonicalSku: 'DUP-1', barcode: null },
  ];

  it('normalizes SKUs (trim + upper-case) and rejects unusable ones', () => {
    expect(normalizeSku('  dbc-vcserum-30 ')).toBe('DBC-VCSERUM-30');
    expect(normalizeSku('A/B')).toBeNull();
    expect(normalizeSku('')).toBeNull();
  });

  it.each([
    ['exact SKU', 'DBC-VCSERUM-30', { status: 'AUTO_MATCHED', variantId: 'v1', reason: 'SKU_EXACT' }],
    [
      'barcode',
      '8906123000021',
      { status: 'AUTO_MATCHED', variantId: 'v2', canonicalSku: 'DBC-VCSERUM-50', reason: 'BARCODE' },
    ],
    ['near match only', 'DBCVCSERUM30', { status: 'MANUAL_MATCH_REQUIRED', variantId: 'v1', canonicalSku: null }],
    ['SKU shared by two catalogue variants', 'DUP-1', { status: 'CONFLICT', variantId: null }],
    ['no match', 'DBC-LIPBALM-10', { status: 'UNMAPPED', variantId: null, canonicalSku: null }],
  ])('%s', (_label, sku, expected) => {
    expect(matchRetailSku(sku, catalog)).toMatchObject(expected);
  });

  it('SKU and barcode pointing at different variants is a CONFLICT', () => {
    const ambiguous = [...catalog, { variantId: 'v5', canonicalSku: 'X-1', barcode: 'DBC-VCSERUM-30' }];
    expect(matchRetailSku('DBC-VCSERUM-30', ambiguous).status).toBe('CONFLICT');
  });

  it('catalogue-side mapping: unique SKU auto, duplicate conflict, missing unmapped', () => {
    const result = mapCatalogVariants([
      { variantId: 'a', sku: 'sku-1' },
      { variantId: 'b', sku: 'SKU-2' },
      { variantId: 'c', sku: 'SKU-2' },
      { variantId: 'd', sku: '' },
    ]);
    expect([...result].map(([id, m]) => [id, m.status, m.canonicalSku])).toEqual([
      ['a', 'AUTO_MATCHED', 'SKU-1'],
      ['b', 'CONFLICT', 'SKU-2'],
      ['c', 'CONFLICT', 'SKU-2'],
      ['d', 'UNMAPPED', null],
    ]);
  });
});

const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };

async function importCsv(world: ReturnType<typeof buildTestWorld>, content: Buffer) {
  const { record } = await world.retailImports.create('brand_A', SYSTEM, 'stock.csv');
  await world.files.write(record.fileKey, content, 'text/csv');
  return world.retailImports.process('brand_A', SYSTEM, record.importId);
}

describe('commerce sync (MockCommerceProvider → products, variants, mappings, connection)', () => {
  it('normalizes the catalogue with deterministic IDs, tags and attributes; no credentials stored', async () => {
    const world = buildTestWorld();
    const connection = await world.commerceSync.sync('brand_A', SYSTEM);
    expect(connection).toMatchObject({ provider: 'SHOPIFY', source: 'MOCK', status: 'CONNECTED', lastError: null });
    expect(connection.productCount).toBe(10);
    expect(connection.variantCount).toBe(18);
    expect(JSON.stringify(connection)).not.toMatch(/token|secret|credential/i);

    const serum = world.products.products.find((p) => p.productId === 'prd_1001')!;
    expect(serum).toMatchObject({ title: 'Vitamin C Glow Serum', shopifyProductId: 'gid://shopify/Product/1001' });
    expect(serum.tags).toContain('serum');
    expect(serum.attributes).toMatchObject({ concern: 'dullness', key_ingredients: 'vitamin C, ferulic acid' });
    expect(world.products.variants.find((v) => v.variantId === 'var_2001')).toMatchObject({
      sku: 'DBC-VCSERUM-30',
      canonicalSku: 'DBC-VCSERUM-30',
      price: 795,
      currency: 'INR',
    });
    expect(world.mappings.mappings.filter((m) => m.sourceSystem === 'SHOPIFY')).toHaveLength(18);
    expect(world.mappings.mappings.every((m) => m.mappingStatus === 'AUTO_MATCHED')).toBe(true);
    expect(world.audit.brandEvents.at(-1)).toMatchObject({ action: 'CATALOG_SYNCED' });
  });

  it('is idempotent: a re-sync updates the same documents and never duplicates', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    const first = structuredClone({ p: world.products.products, v: world.products.variants });
    const firstSync = (await world.connections.get('brand_A', 'SHOPIFY'))!;
    await world.commerceSync.sync('brand_A', SYSTEM);
    expect(world.products.products).toEqual(first.p);
    expect(world.products.variants).toEqual(first.v);
    expect(world.mappings.mappings).toHaveLength(18);
    expect(world.connections.connections).toHaveLength(1);
    expect((await world.connections.get('brand_A', 'SHOPIFY'))!.connectedAt).toBe(firstSync.connectedAt);
  });

  it('records a safe, normalized error when the provider fails', async () => {
    const failing = { name: 'MOCK', getProducts: () => Promise.reject(new Error('secret upstream detail')) };
    const world = buildTestWorld({ commerce: failing as never });
    await expect(world.commerceSync.sync('brand_A', SYSTEM)).rejects.toMatchObject({ code: 'COMMERCE_SYNC_FAILED' });
    const connection = (await world.connections.get('brand_A', 'SHOPIFY'))!;
    expect(connection).toMatchObject({ status: 'ERROR', lastError: { code: 'COMMERCE_SYNC_FAILED' } });
    expect(JSON.stringify(connection)).not.toContain('secret upstream detail');
  });
});

describe('RetailImportService (validate → normalize → map → Firestore)', () => {
  it('imports the demo CSV: stores, stock, mappings and a report with real row errors', async () => {
    const world = buildTestWorld();
    world.retailers.retailers.push(
      { brandId: 'brand_A', retailerId: 'rtl_north', name: 'North Retail', status: 'ACTIVE' },
      { brandId: 'brand_A', retailerId: 'rtl_pune', name: 'Pune Retail', status: 'ACTIVE' },
    );
    await world.commerceSync.sync('brand_A', SYSTEM);
    const demo = readFileSync(new URL('../fixtures/retail/demo-retail.csv', import.meta.url));
    const report = await importCsv(world, demo);

    expect(report.record).toMatchObject({
      status: 'COMPLETED',
      rowsProcessed: 36,
      rowsValid: 33,
      rowsInvalid: 3,
      mappingsFailed: 1,
    });
    expect(report.rowErrors.map((e) => [e.code, e.sku, e.storeId])).toEqual([
      ['INVALID_QUANTITY', 'DBC-SALCLN-100', 'st_north_1'],
      ['UNKNOWN_SKU', 'DBC-LIPBALM-10', 'st_north_2'],
      ['INVALID_PRICE', 'DBC-HASERUM-30', 'st_pune_1'],
    ]);

    // Stores created with their retailer, never with a Retail Admin.
    const powai = (await world.stores.get('brand_A', 'st_north_3'))!;
    expect(powai).toMatchObject({ retailerId: 'rtl_north', retailAdminUserId: null, storeName: 'Powai Store' });
    expect(powai.storeHours).toMatchObject({ timezone: 'Asia/Kolkata', sunday: '' });

    // The demo story: Vitamin C serum 30 ml — Powai 0, Bandra 3, Andheri 5; 50 ml: 0 in all Mumbai stores.
    const qty = (store: string, sku: string) =>
      world.inventory.rows.find((r) => r.storeId === store && r.canonicalSku === sku)?.quantity;
    expect([
      qty('st_north_3', 'DBC-VCSERUM-30'),
      qty('st_north_1', 'DBC-VCSERUM-30'),
      qty('st_north_2', 'DBC-VCSERUM-30'),
    ]).toEqual([0, 3, 5]);
    expect(['st_north_1', 'st_north_2', 'st_north_3'].map((s) => qty(s, 'DBC-VCSERUM-50'))).toEqual([0, 0, 0]);
    expect(qty('st_pune_1', 'DBC-VCSERUM-50')).toBe(4);
    expect(world.inventory.rows.find((r) => r.inventoryId === 'st_north_1__DBC-VCSERUM-30')).toMatchObject({
      variantId: 'var_2001',
      availabilityStatus: 'LOW_STOCK',
    });

    // The unknown SKU stays visible as an UNMAPPED mapping; it never becomes stock.
    expect(world.mappings.mappings.find((m) => m.sourceIdentifier === 'DBC-LIPBALM-10')).toMatchObject({
      sourceSystem: 'RETAIL_FILE',
      mappingStatus: 'UNMAPPED',
    });
    expect(world.inventory.rows.some((r) => r.sku === 'DBC-LIPBALM-10')).toBe(false);

    // The row-error report is stored through FileStorageProvider and read back.
    expect(report.record.rowErrorsReference).toMatch(/^retail-imports\/brand_A\/imp_[0-9a-f]{16}\.errors\.json$/);
    expect((await world.retailImports.get('brand_A', report.record.importId)).rowErrors).toHaveLength(3);
    expect(world.audit.brandEvents.map((e) => e.action)).toContain('RETAIL_IMPORT_PROCESSED');
  });

  it('re-import overwrites quantity but NEVER reserved_quantity', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    await importCsv(world, csv([{ quantity: '10' }]));
    const row = world.inventory.rows.find((r) => r.inventoryId === 'store_A__DBC-VCSERUM-30')!;
    row.reservedQuantity = 2; // held by a reservation (M5)

    await importCsv(world, csv([{ quantity: '3' }]));
    expect(row).toMatchObject({ quantity: 3, reservedQuantity: 2, availabilityStatus: 'LOW_STOCK' });
    await importCsv(world, csv([{ quantity: '2' }]));
    expect(row).toMatchObject({ quantity: 2, reservedQuantity: 2, availabilityStatus: 'OUT_OF_STOCK' });
  });

  it('a store owned by another retailer is reported as a conflict and never moved', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    const report = await importCsv(world, csv([{ retailer_id: 'rtl_X', address: 'Moved?' }]));
    expect(report.rowErrors.map((e) => e.code)).toEqual(['RETAILER_CONFLICT']);
    expect(await world.stores.get('brand_A', 'store_A')).toMatchObject({
      retailerId: 'rtl_A',
      address: 'store_A street, Mumbai',
    });
    expect(world.inventory.rows).toHaveLength(0);
  });

  it('an unknown retailer_id is a row error; a new store is created with its retailer and no admin', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    const report = await importCsv(
      world,
      csv([
        { store_id: 'store_ghost', retailer_id: 'rtl_nope' },
        { store_id: 'store_new', retailer_id: 'rtl_A' },
      ]),
    );
    expect(report.rowErrors.map((e) => [e.storeId, e.code])).toEqual([['store_ghost', 'UNKNOWN_RETAILER']]);
    expect(await world.stores.get('brand_A', 'store_ghost')).toBeNull();
    expect(await world.stores.get('brand_A', 'store_new')).toMatchObject({
      retailerId: 'rtl_A',
      retailAdminUserId: null,
    });
  });

  it('never touches the Retail Admin of an existing store', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    await importCsv(world, csv([{ store_name: 'Store A (renamed)' }]));
    expect(await world.stores.get('brand_A', 'store_A')).toMatchObject({
      storeName: 'Store A (renamed)',
      retailerId: 'rtl_A',
      retailAdminUserId: 'radmin_A',
    });
  });

  it('SKU conflicts and near matches are row errors whose mappings stay visible', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    world.products.variants.push({
      ...world.products.variants[0]!,
      variantId: 'var_dup',
      shopifyVariantId: 'gid://x/1',
    });
    const report = await importCsv(world, csv([{}, { sku: 'DBCMINSPF50' }]));
    expect(report.rowErrors.map((e) => e.code)).toEqual(['SKU_CONFLICT', 'SKU_NEEDS_REVIEW']);
    const retail = world.mappings.mappings.filter((m) => m.sourceSystem === 'RETAIL_FILE');
    expect(retail.map((m) => m.mappingStatus).sort()).toEqual(['CONFLICT', 'MANUAL_MATCH_REQUIRED']);
    expect(report.record).toMatchObject({ mappingsCreated: 0, mappingsFailed: 2, rowsInvalid: 2 });
  });

  it('an import before any catalogue sync maps nothing (all UNKNOWN_SKU), without failing', async () => {
    const world = buildTestWorld();
    const report = await importCsv(world, csv([{}]));
    expect(report.record.status).toBe('COMPLETED');
    expect(report.rowErrors.map((e) => e.code)).toEqual(['UNKNOWN_SKU']);
  });

  it('file-level failures: missing columns, not uploaded, processed twice, too large', async () => {
    const world = buildTestWorld();
    const missing = await importCsv(
      world,
      csv(
        [{}],
        COLUMNS.filter((c) => c !== 'sku'),
      ),
    );
    expect(missing.record).toMatchObject({ status: 'FAILED', failureCode: 'MISSING_COLUMNS' });
    expect(missing.rowErrors.map((e) => e.field)).toEqual(['sku']);

    const { record } = await world.retailImports.create('brand_A', SYSTEM, 'x.csv');
    await expect(world.retailImports.process('brand_A', SYSTEM, record.importId)).rejects.toMatchObject({
      code: 'FILE_NOT_UPLOADED',
    });
    await world.files.write(record.fileKey, csv([{}]), 'text/csv');
    await world.retailImports.process('brand_A', SYSTEM, record.importId);
    await expect(world.retailImports.process('brand_A', SYSTEM, record.importId)).rejects.toMatchObject({
      code: 'IMPORT_ALREADY_PROCESSED',
    });

    const big = await world.retailImports.create('brand_A', SYSTEM, 'big.csv');
    await world.files.write(big.record.fileKey, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'), 'text/csv');
    const tooLarge = await world.retailImports.process('brand_A', SYSTEM, big.record.importId);
    expect(tooLarge.record).toMatchObject({ status: 'FAILED', failureCode: 'FILE_TOO_LARGE' });
  });
});

describe('StoreService.findEligibleStores reads Firestore through the ports', () => {
  it('returns eligible stores for a variant and the reason for every other store', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    await importCsv(world, csv([{ quantity: '4' }, { store_id: 'store_B', quantity: '0' }]));
    const at = (instant: string) =>
      new StoreService({ stores: world.stores, inventory: world.inventory, now: () => new Date(instant) });
    const origin = { latitude: 19.06, longitude: 72.83 };

    // Monday 12:00 in Asia/Kolkata: store_A is open with stock.
    const monday = await at('2026-10-05T06:30:00Z').findEligibleStores('brand_A', 'var_2001', origin, 10);
    expect(monday.eligible.map((s) => [s.storeId, s.availableQuantity])).toEqual([['store_A', 4]]);
    expect(monday.excluded.find((s) => s.storeId === 'store_B')?.reason).toBe('OUT_OF_STOCK');
    expect(monday.excluded.find((s) => s.storeId === 'store_C')?.reason).toBe('OUT_OF_STOCK'); // never stocked

    // Sunday: the imported hours leave Sunday empty, so store_A is closed.
    const sunday = await at('2026-10-04T06:30:00Z').findEligibleStores('brand_A', 'var_2001', origin, 10);
    expect(sunday.eligible).toEqual([]);
    expect(sunday.excluded.find((s) => s.storeId === 'store_A')?.reason).toBe('CLOSED');
  });
});
