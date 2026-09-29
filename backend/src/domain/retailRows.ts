/**
 * Validation and normalization of retail file rows against the canonical retail schema
 * (docs/04_DATA_MODEL.md §9.1–§9.2, docs/08_TEST_PLAN.md §6). Pure: the same rules run in
 * every profile. Every rejected row is reported with a code — nothing is dropped silently.
 */
import { isValidTenantId } from './principal.js';
import { normalizeSku } from './skuMapping.js';
import { validateStoreHours, WEEKDAYS, type StoreHours } from './storeHours.js';

export const HOURS_COLUMNS = ['store_hours.timezone', ...WEEKDAYS.map((d) => `store_hours.${d}`)];

export const REQUIRED_COLUMNS = [
  'store_id',
  'store_name',
  'city',
  'address',
  'latitude',
  'longitude',
  ...HOURS_COLUMNS,
  'store_status',
  'sku',
  'quantity',
  'offline_price',
];

export const OPTIONAL_COLUMNS = ['pickup_available', 'reservation_available', 'retailer_id'];

export type RowErrorCode =
  | 'MISSING_VALUE'
  | 'INVALID_STORE_ID'
  | 'INVALID_SKU'
  | 'INVALID_COORDINATES'
  | 'INVALID_QUANTITY'
  | 'INVALID_PRICE'
  | 'INVALID_STATUS'
  | 'INVALID_BOOLEAN'
  | 'INVALID_TIMEZONE'
  | 'INVALID_HOURS'
  | 'INVALID_RETAILER_ID'
  | 'DUPLICATE_ROW'
  | 'STORE_FIELDS_CONFLICT'
  // Raised by the import service after validation:
  | 'UNKNOWN_RETAILER'
  | 'RETAILER_CONFLICT'
  | 'UNKNOWN_SKU'
  | 'SKU_CONFLICT'
  | 'SKU_NEEDS_REVIEW';

export interface RowError {
  line: number;
  storeId: string | null;
  sku: string | null;
  code: RowErrorCode;
  field: string | null;
  message: string;
}

export interface NormalizedStore {
  storeId: string;
  storeName: string;
  city: string;
  address: string;
  latitude: number;
  longitude: number;
  storeHours: StoreHours;
  storeStatus: 'ACTIVE' | 'INACTIVE';
  reservationAvailable: boolean;
  pickupAvailable: boolean;
  /** From the optional column; null when absent (ownership is then left unchanged). */
  retailerId: string | null;
}

export interface StockRow {
  line: number;
  storeId: string;
  /** Retail SKU as uploaded, normalized. */
  sku: string;
  quantity: number;
  offlinePrice: number;
}

export type RetailRowsResult =
  | { ok: false; missingColumns: string[] }
  | { ok: true; stores: Map<string, NormalizedStore>; stockRows: StockRow[]; errors: RowError[] };

const DECIMAL = /^\d+(\.\d{1,2})?$/;
const INTEGER = /^\d+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const RETAILER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseBoolean(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === '') return true; // docs/04 §9: optional, default true
  if (['true', 'yes', 'y', '1'].includes(v)) return true;
  if (['false', 'no', 'n', '0'].includes(v)) return false;
  return undefined;
}

class RowProblem extends Error {
  constructor(
    readonly code: RowErrorCode,
    readonly field: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** Validates one row; throws RowProblem for the first problem found. */
function normalizeRow(values: Record<string, string>): {
  store: NormalizedStore;
  sku: string;
  quantity: number;
  offlinePrice: number;
} {
  const get = (column: string) => (values[column] ?? '').trim();
  const required = (column: string) => {
    const value = get(column);
    if (value === '') throw new RowProblem('MISSING_VALUE', column, `${column} is required.`);
    return value;
  };

  const storeId = required('store_id');
  if (!RETAILER_ID.test(storeId) || !isValidTenantId(storeId)) {
    throw new RowProblem('INVALID_STORE_ID', 'store_id', 'store_id must be 1–64 letters, digits, "_" or "-".');
  }
  const rawSku = required('sku');
  const sku = normalizeSku(rawSku);
  if (!sku) throw new RowProblem('INVALID_SKU', 'sku', 'sku must be 1–64 letters, digits, ".", "_" or "-".');

  const storeName = required('store_name');
  const city = required('city');
  const address = required('address');

  const lat = required('latitude');
  const lng = required('longitude');
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!NUMBER.test(lat) || !NUMBER.test(lng) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new RowProblem('INVALID_COORDINATES', 'latitude', 'latitude/longitude must be valid decimal degrees.');
  }

  const storeHours: StoreHours = { timezone: required('store_hours.timezone') };
  for (const day of WEEKDAYS) storeHours[day] = get(`store_hours.${day}`);
  const hoursProblem = validateStoreHours(storeHours);
  if (hoursProblem?.code === 'INVALID_TIMEZONE') {
    throw new RowProblem(
      'INVALID_TIMEZONE',
      'store_hours.timezone',
      'store_hours.timezone must be an IANA timezone such as Asia/Kolkata.',
    );
  }
  if (hoursProblem?.code === 'INVALID_HOURS') {
    throw new RowProblem(
      'INVALID_HOURS',
      `store_hours.${hoursProblem.day}`,
      `store_hours.${hoursProblem.day} must be empty (closed) or "HH:MM-HH:MM" with opening before closing.`,
    );
  }

  const status = required('store_status').toUpperCase();
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    throw new RowProblem('INVALID_STATUS', 'store_status', 'store_status must be ACTIVE or INACTIVE.');
  }

  const qty = required('quantity');
  if (!INTEGER.test(qty)) {
    throw new RowProblem('INVALID_QUANTITY', 'quantity', 'quantity must be a whole number of 0 or more.');
  }
  const price = required('offline_price');
  if (!DECIMAL.test(price)) {
    throw new RowProblem(
      'INVALID_PRICE',
      'offline_price',
      'offline_price must be a non-negative amount with up to 2 decimals.',
    );
  }

  const reservationAvailable = parseBoolean(get('reservation_available'));
  const pickupAvailable = parseBoolean(get('pickup_available'));
  if (reservationAvailable === undefined || pickupAvailable === undefined) {
    throw new RowProblem(
      'INVALID_BOOLEAN',
      'reservation_available',
      'pickup_available / reservation_available must be true or false.',
    );
  }

  const retailerRaw = get('retailer_id');
  if (retailerRaw && (!RETAILER_ID.test(retailerRaw) || !isValidTenantId(retailerRaw))) {
    throw new RowProblem('INVALID_RETAILER_ID', 'retailer_id', 'retailer_id is not a valid retailer ID.');
  }

  return {
    store: {
      storeId,
      storeName,
      city,
      address,
      latitude,
      longitude,
      storeHours,
      storeStatus: status,
      reservationAvailable,
      pickupAvailable,
      retailerId: retailerRaw || null,
    },
    sku,
    quantity: Number(qty),
    offlinePrice: Number(price),
  };
}

/**
 * Validates every row. Rules beyond single-row validation:
 * - the same store_id + sku twice → later occurrences are DUPLICATE_ROW;
 * - store-level fields must be identical on every row of a store_id; if they are not,
 *   EVERY row of that store is STORE_FIELDS_CONFLICT and the store is not imported.
 */
export function validateRetailRows(
  header: string[],
  rows: { line: number; values: Record<string, string> }[],
): RetailRowsResult {
  const columns = new Set(header.map((h) => h.trim()));
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missingColumns.length > 0) return { ok: false, missingColumns };

  const errors: RowError[] = [];
  const accepted: { line: number; store: NormalizedStore; sku: string; quantity: number; offlinePrice: number }[] = [];
  const seen = new Set<string>();

  for (const { line, values } of rows) {
    try {
      const row = normalizeRow(values);
      const key = `${row.store.storeId}\u0000${row.sku}`;
      if (seen.has(key)) {
        throw new RowProblem('DUPLICATE_ROW', 'sku', 'This store and SKU already appear on an earlier row.');
      }
      seen.add(key);
      accepted.push({ line, ...row });
    } catch (err) {
      if (!(err instanceof RowProblem)) throw err;
      errors.push({
        line,
        storeId: (values.store_id ?? '').trim() || null,
        sku: (values.sku ?? '').trim() || null,
        code: err.code,
        field: err.field,
        message: err.message,
      });
    }
  }

  // Store-level consistency.
  const signature = (s: NormalizedStore) => JSON.stringify(s);
  const byStore = new Map<string, typeof accepted>();
  for (const row of accepted) byStore.set(row.store.storeId, [...(byStore.get(row.store.storeId) ?? []), row]);

  const stores = new Map<string, NormalizedStore>();
  const stockRows: StockRow[] = [];
  for (const [storeId, storeRows] of byStore) {
    if (new Set(storeRows.map((r) => signature(r.store))).size > 1) {
      for (const r of storeRows) {
        errors.push({
          line: r.line,
          storeId,
          sku: r.sku,
          code: 'STORE_FIELDS_CONFLICT',
          field: null,
          message: 'Store details differ between rows of this store_id; fix them so every row agrees.',
        });
      }
      continue;
    }
    stores.set(storeId, storeRows[0]!.store);
    for (const r of storeRows) {
      stockRows.push({ line: r.line, storeId, sku: r.sku, quantity: r.quantity, offlinePrice: r.offlinePrice });
    }
  }

  errors.sort((a, b) => a.line - b.line);
  return { ok: true, stores, stockRows, errors };
}
