/**
 * In-store sales (Change 19): a store records the invoice of a walk-in sale — a shopper who
 * came in on their own, with no Qwikspot hold — and the sold units leave its stock at once, so
 * every shopper Qwikspot answers next sees the store's real stock. Pure rules: validation, the
 * stock check, totals and the stock-change reasons. No I/O.
 *
 * A walk-in sale may only take AVAILABLE stock (on hand − held for Qwikspot shoppers): a unit
 * held for a shopper on their way is not sold to someone else. A store that must sell it refuses
 * the hold first (the shopper is told), then records the sale.
 */
import { availableQuantity } from './storeTruth.js';

export const MAX_SALE_LINES = 20;
export const MAX_LINE_QUANTITY = 50;
/** A sale can be voided (a mistake, a return the same day) for this long after it was recorded. */
export const VOID_WINDOW_HOURS = 24;

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Why a store's stock last changed (stored on the stock row; the AI's stock tool reports it).
 * HOLD_PLACED / HOLD_RELEASED change only what is available, never what is on hand.
 */
export const STOCK_CHANGE_REASONS = [
  'RETAIL_IMPORT',
  'IN_STORE_SALE',
  'SALE_VOIDED',
  'QWIKSPOT_PICKUP',
  'HOLD_PLACED',
  'HOLD_RELEASED',
] as const;
export type StockChangeReason = (typeof STOCK_CHANGE_REASONS)[number];

export interface SaleLineInput {
  sku: string;
  quantity: number;
}

/** The store's stock row for one SKU, as the sale sees it inside its transaction. */
export interface SaleStock {
  sku: string;
  canonicalSku: string;
  variantId: string;
  quantity: number;
  reservedQuantity: number;
  offlinePrice: number;
}

export interface PricedLine {
  sku: string;
  canonicalSku: string;
  variantId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export type SaleCheck =
  | { ok: true; lines: PricedLine[]; total: number; units: number }
  | { ok: false; code: 'INVALID_SALE'; message: string }
  | { ok: false; code: 'UNKNOWN_SKU'; skus: string[] }
  | {
      ok: false;
      code: 'NOT_ENOUGH_STOCK';
      lines: { sku: string; requested: number; available: number; held: number }[];
    };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The same SKU twice in one invoice is one line with the quantities added up. */
export function mergeLines(lines: SaleLineInput[]): SaleLineInput[] {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.sku, (out.get(l.sku) ?? 0) + l.quantity);
  return [...out.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

/**
 * Checks a walk-in sale against the store's stock: every SKU known to the store, whole
 * quantities, never more than is available. Prices are the store's own offline prices.
 */
export function checkSale(input: SaleLineInput[], stock: SaleStock[]): SaleCheck {
  if (input.length === 0) return { ok: false, code: 'INVALID_SALE', message: 'Add at least one product.' };
  const lines = mergeLines(input);
  if (lines.length > MAX_SALE_LINES)
    return { ok: false, code: 'INVALID_SALE', message: `An invoice has at most ${MAX_SALE_LINES} products.` };
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_LINE_QUANTITY)
      return {
        ok: false,
        code: 'INVALID_SALE',
        message: `Each quantity is a whole number from 1 to ${MAX_LINE_QUANTITY}.`,
      };
  }
  const bySku = new Map(stock.map((s) => [s.sku, s]));
  const unknown = lines.filter((l) => !bySku.has(l.sku)).map((l) => l.sku);
  if (unknown.length) return { ok: false, code: 'UNKNOWN_SKU', skus: unknown };
  const short = lines
    .map((l) => {
      const s = bySku.get(l.sku)!;
      return {
        sku: l.sku,
        requested: l.quantity,
        available: availableQuantity(s.quantity, s.reservedQuantity),
        held: s.reservedQuantity,
      };
    })
    .filter((x) => x.requested > x.available);
  if (short.length) return { ok: false, code: 'NOT_ENOUGH_STOCK', lines: short };
  const priced = lines.map((l) => {
    const s = bySku.get(l.sku)!;
    return {
      sku: l.sku,
      canonicalSku: s.canonicalSku,
      variantId: s.variantId,
      quantity: l.quantity,
      unitPrice: s.offlinePrice,
      lineTotal: round2(s.offlinePrice * l.quantity),
    };
  });
  return {
    ok: true,
    lines: priced,
    total: round2(priced.reduce((n, l) => n + l.lineTotal, 0)),
    units: priced.reduce((n, l) => n + l.quantity, 0),
  };
}

/** "INV-000042": the store's own running number. */
export const invoiceNumber = (n: number) => `INV-${String(n).padStart(6, '0')}`;

/** Whether a sale recorded at `createdAt` may still be voided at `now`. */
export const canVoid = (createdAt: string, now: Date) =>
  now.getTime() - Date.parse(createdAt) <= VOID_WINDOW_HOURS * 3_600_000;
