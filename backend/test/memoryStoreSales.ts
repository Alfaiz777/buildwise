/**
 * In-memory StoreSaleRepository for tests, on the same inventory rows as MemoryInventory and
 * MemoryReservations. Each record / void runs without an await between its check and its writes,
 * so it is atomic against holds just as the Firestore transaction is.
 */
import { randomBytes } from 'node:crypto';
import { invoiceNumber, type SaleStock } from '../src/domain/storeSale.js';
import { deriveAvailabilityStatus } from '../src/domain/storeTruth.js';
import type { InventoryRecord } from '../src/ports/repositories.js';
import type {
  RecordSaleInput,
  RecordSaleResult,
  StockMovementRecord,
  StoreSaleRecord,
  StoreSaleRepository,
  VoidSaleResult,
} from '../src/ports/storeSales.js';

const clone = <T>(v: T): T => structuredClone(v);
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

export class MemoryStoreSales implements StoreSaleRepository {
  readonly sales: StoreSaleRecord[] = [];
  readonly movementsLog: StockMovementRecord[] = [];
  private readonly counters = new Map<string, number>();

  constructor(private readonly inventory: { rows: InventoryRecord[] }) {}

  async record(input: RecordSaleInput): Promise<RecordSaleResult> {
    const rows = this.inventory.rows.filter((r) => r.brandId === input.brandId && r.storeId === input.storeId);
    const stock: SaleStock[] = rows.map((r) => ({
      sku: r.sku,
      canonicalSku: r.canonicalSku,
      variantId: r.variantId,
      quantity: r.quantity,
      reservedQuantity: r.reservedQuantity,
      offlinePrice: r.offlinePrice,
    }));
    const check = input.check(input.lines, stock);
    if (!check.ok) return { status: 'REJECTED', check };
    const key = `${input.brandId}/${input.storeId}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const sale: StoreSaleRecord = {
      saleId: newId('sale'),
      brandId: input.brandId,
      storeId: input.storeId,
      invoiceNumber: invoiceNumber(next),
      lines: check.lines.map((l) => ({
        ...l,
        productTitle: input.titles.get(l.canonicalSku)?.productTitle ?? null,
        variantTitle: input.titles.get(l.canonicalSku)?.variantTitle ?? null,
      })),
      units: check.units,
      total: check.total,
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      status: 'RECORDED',
      createdAt: input.at,
      createdBy: input.createdBy,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    };
    const after: { sku: string; quantity: number; reservedQuantity: number }[] = [];
    for (const line of check.lines) {
      const row = rows.find((r) => r.sku === line.sku)!;
      row.quantity -= line.quantity;
      row.availabilityStatus = deriveAvailabilityStatus(row.quantity, row.reservedQuantity);
      row.lastUpdatedAt = input.at;
      row.lastChangeReason = 'IN_STORE_SALE';
      row.lastChangeAt = input.at;
      after.push({ sku: row.sku, quantity: row.quantity, reservedQuantity: row.reservedQuantity });
      this.movementsLog.push({
        movementId: newId('mov'),
        brandId: input.brandId,
        storeId: input.storeId,
        sku: row.sku,
        canonicalSku: row.canonicalSku,
        variantId: row.variantId,
        delta: -line.quantity,
        quantityAfter: row.quantity,
        reason: 'IN_STORE_SALE',
        saleId: sale.saleId,
        invoiceNumber: sale.invoiceNumber,
        at: input.at,
      });
    }
    this.sales.push(sale);
    return { status: 'RECORDED', sale: clone(sale), stock: after };
  }

  async void(input: Parameters<StoreSaleRepository['void']>[0]): Promise<VoidSaleResult> {
    const sale = this.sales.find((s) => s.brandId === input.brandId && s.saleId === input.saleId);
    if (!sale || sale.storeId !== input.storeId) return { status: 'NOT_FOUND' };
    if (sale.status === 'VOIDED') return { status: 'ALREADY_VOIDED', sale: clone(sale) };
    if (!input.allowed(sale.createdAt)) return { status: 'TOO_LATE', sale: clone(sale) };
    for (const l of sale.lines) {
      const row = this.inventory.rows.find(
        (r) => r.brandId === sale.brandId && r.inventoryId === `${sale.storeId}__${l.canonicalSku}`,
      );
      if (!row) continue;
      row.quantity += l.quantity;
      row.availabilityStatus = deriveAvailabilityStatus(row.quantity, row.reservedQuantity);
      row.lastUpdatedAt = input.at;
      row.lastChangeReason = 'SALE_VOIDED';
      row.lastChangeAt = input.at;
      this.movementsLog.push({
        movementId: newId('mov'),
        brandId: sale.brandId,
        storeId: sale.storeId,
        sku: l.sku,
        canonicalSku: l.canonicalSku,
        variantId: l.variantId,
        delta: l.quantity,
        quantityAfter: row.quantity,
        reason: 'SALE_VOIDED',
        saleId: sale.saleId,
        invoiceNumber: sale.invoiceNumber,
        at: input.at,
      });
    }
    Object.assign(sale, { status: 'VOIDED', voidedAt: input.at, voidedBy: input.by, voidReason: input.reason });
    return { status: 'VOIDED', sale: clone(sale) };
  }

  async get(brandId: string, saleId: string) {
    const s = this.sales.find((x) => x.brandId === brandId && x.saleId === saleId);
    return s ? clone(s) : null;
  }

  async listByStore(brandId: string, storeId: string, since: string) {
    return (await this.listByBrand(brandId, since)).filter((s) => s.storeId === storeId);
  }

  async listByBrand(brandId: string, since: string) {
    return [...this.sales]
      .reverse()
      .filter((s) => s.brandId === brandId && s.createdAt >= since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async movements(brandId: string, storeId: string, options: { sku?: string; limit: number }) {
    // Newest first; the same instant keeps the latest write first (as a real clock would order them).
    return [...this.movementsLog]
      .reverse()
      .filter((m) => m.brandId === brandId && m.storeId === storeId && (!options.sku || m.sku === options.sku))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, options.limit)
      .map(clone);
  }
}
