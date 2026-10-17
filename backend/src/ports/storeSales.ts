import type {
  PaymentMethod,
  PricedLine,
  SaleCheck,
  SaleLineInput,
  SaleStock,
  StockChangeReason,
} from '../domain/storeSale.js';

/** One walk-in sale's invoice (docs/04 §15a, Change 19). Never a customer: no name, phone or email. */
export interface StoreSaleRecord {
  saleId: string;
  brandId: string;
  storeId: string;
  invoiceNumber: string;
  lines: (PricedLine & { productTitle: string | null; variantTitle: string | null })[];
  units: number;
  total: number;
  currency: string;
  paymentMethod: PaymentMethod;
  status: 'RECORDED' | 'VOIDED';
  /** ISO-8601 */
  createdAt: string;
  createdBy: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

/** One change to a stock row with its reason (the store's stock history). */
export interface StockMovementRecord {
  movementId: string;
  brandId: string;
  storeId: string;
  sku: string;
  canonicalSku: string;
  variantId: string;
  /** Change to the units on hand (−2 for a sale of 2, +2 when it is voided). */
  delta: number;
  quantityAfter: number;
  reason: StockChangeReason;
  /** The sale it belongs to. */
  saleId: string;
  invoiceNumber: string;
  at: string;
}

export interface RecordSaleInput {
  brandId: string;
  storeId: string;
  lines: SaleLineInput[];
  paymentMethod: PaymentMethod;
  currency: string;
  createdBy: string;
  /** Titles for the invoice, by canonical SKU (looked up before the transaction). */
  titles: Map<string, { productTitle: string | null; variantTitle: string | null }>;
  at: string;
  /** The pure rule, applied inside the transaction to the stock it read. */
  check: (lines: SaleLineInput[], stock: SaleStock[]) => SaleCheck;
}

export type RecordSaleResult =
  | { status: 'RECORDED'; sale: StoreSaleRecord; stock: { sku: string; quantity: number; reservedQuantity: number }[] }
  | { status: 'REJECTED'; check: Exclude<SaleCheck, { ok: true }> };

export type VoidSaleResult =
  | { status: 'VOIDED'; sale: StoreSaleRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'ALREADY_VOIDED'; sale: StoreSaleRecord }
  | { status: 'TOO_LATE'; sale: StoreSaleRecord };

/**
 * Walk-in sales and their stock movements. `record` and `void` are ATOMIC with the stock rows
 * they change: the sale, its stock deduction and its movements are written together or not at
 * all, in the same transaction a Qwikspot hold uses for that store × SKU — so a walk-in sale and
 * a hold can never both take the last unit.
 */
export interface StoreSaleRepository {
  record(input: RecordSaleInput): Promise<RecordSaleResult>;
  void(input: {
    brandId: string;
    storeId: string;
    saleId: string;
    by: string;
    reason: string;
    at: string;
    allowed: (createdAt: string) => boolean;
  }): Promise<VoidSaleResult>;
  get(brandId: string, saleId: string): Promise<StoreSaleRecord | null>;
  /** The store's sales recorded at or after `since` (ISO), newest first. */
  listByStore(brandId: string, storeId: string, since: string): Promise<StoreSaleRecord[]>;
  /** Every store's sales recorded at or after `since` (ISO), newest first. */
  listByBrand(brandId: string, since: string): Promise<StoreSaleRecord[]>;
  /** The store's latest stock movements, newest first (optionally one SKU). */
  movements(brandId: string, storeId: string, options: { sku?: string; limit: number }): Promise<StockMovementRecord[]>;
}
