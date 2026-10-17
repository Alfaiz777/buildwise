import { checkSale, canVoid, type PaymentMethod, type SaleLineInput } from '../domain/storeSale.js';
import type { RetailPrincipal } from '../domain/principal.js';
import { AppError, Errors } from '../lib/errors.js';
import type { AuditRepository, InventoryRepository, StoreRepository } from '../ports/repositories.js';
import type { ReservationRepository } from '../ports/reservations.js';
import type { StockMovementRecord, StoreSaleRecord, StoreSaleRepository } from '../ports/storeSales.js';
import type { StoreStockLine } from './accountService.js';

const DAY_MS = 24 * 3_600_000;

/**
 * In-store sales (Change 19). The Store Console records the invoice of a walk-in sale; the sold
 * units leave the store's stock in the same transaction, so the next shopper Qwikspot answers
 * sees the real stock, and the stock row says why it changed. The Brand Console sees every
 * store's walk-in sales next to its Qwikspot pickups — counts and values, never a customer.
 */
export class StoreSalesService {
  constructor(
    private readonly deps: {
      sales: StoreSaleRepository;
      /** The Retail Admin's own store's stock with titles (AccountService.storeStock: 404 for another store). */
      storeStock: (principal: RetailPrincipal, storeId: string) => Promise<StoreStockLine[]>;
      inventory: InventoryRepository;
      stores: StoreRepository;
      reservations: ReservationRepository;
      audit: AuditRepository;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Records a walk-in sale at the principal's own store and deducts its stock. */
  async record(
    principal: RetailPrincipal,
    storeId: string,
    input: { lines: SaleLineInput[]; paymentMethod: PaymentMethod },
  ): Promise<StoreSaleRecord> {
    const stock = await this.deps.storeStock(principal, storeId); // 404 for any other store
    const titles = new Map(
      stock.map((s) => [s.canonicalSku, { productTitle: s.productTitle, variantTitle: s.variantTitle }]),
    );
    const at = this.now().toISOString();
    const result = await this.deps.sales.record({
      brandId: principal.brandId,
      storeId,
      lines: input.lines,
      paymentMethod: input.paymentMethod,
      currency: 'INR',
      createdBy: principal.userId,
      titles,
      at,
      check: checkSale,
    });
    if (result.status === 'REJECTED') {
      const c = result.check;
      await this.audit(principal, 'STORE_SALE_RECORDED', storeId, 'DENIED', c.code);
      if (c.code === 'INVALID_SALE') throw Errors.invalidRequest(c.message);
      if (c.code === 'UNKNOWN_SKU')
        throw new AppError(422, 'UNKNOWN_SKU', `Not in this store's stock: ${c.skus.join(', ')}.`);
      const words = c.lines.map(
        (l) => `${l.sku}: ${l.available} available${l.held ? ` (${l.held} held for Qwikspot shoppers)` : ''}`,
      );
      throw new AppError(409, 'NOT_ENOUGH_STOCK', `Not enough stock — ${words.join('; ')}.`);
    }
    await this.audit(principal, 'STORE_SALE_RECORDED', result.sale.saleId, 'SUCCESS', null);
    return result.sale;
  }

  /** Voids a sale of the own store within 24 h (a mistake or a same-day return): the stock comes back. */
  async void(principal: RetailPrincipal, storeId: string, saleId: string, reason: string): Promise<StoreSaleRecord> {
    await this.deps.storeStock(principal, storeId); // 404 for any other store
    const at = this.now();
    const result = await this.deps.sales.void({
      brandId: principal.brandId,
      storeId,
      saleId,
      by: principal.userId,
      reason,
      at: at.toISOString(),
      allowed: (createdAt) => canVoid(createdAt, at),
    });
    if (result.status === 'NOT_FOUND') throw Errors.notFound();
    if (result.status === 'ALREADY_VOIDED')
      throw new AppError(409, 'ALREADY_VOIDED', `${result.sale.invoiceNumber} was already voided.`);
    if (result.status === 'TOO_LATE') {
      await this.audit(principal, 'STORE_SALE_VOIDED', saleId, 'DENIED', 'VOID_WINDOW_PASSED');
      throw new AppError(409, 'VOID_WINDOW_PASSED', 'A sale can be voided only within 24 hours of recording it.');
    }
    await this.audit(principal, 'STORE_SALE_VOIDED', saleId, 'SUCCESS', null);
    return result.sale;
  }

  /** The own store's sales of the last `days` days, newest first, with totals. */
  async storeSales(principal: RetailPrincipal, storeId: string, days: number) {
    await this.deps.storeStock(principal, storeId);
    const since = new Date(this.now().getTime() - days * DAY_MS).toISOString();
    const sales = await this.deps.sales.listByStore(principal.brandId, storeId, since);
    return { sales, totals: totalsOf(sales) };
  }

  /** The own store's latest stock changes with their reason (one SKU, or all). */
  async stockHistory(principal: RetailPrincipal, storeId: string, sku?: string): Promise<StockMovementRecord[]> {
    await this.deps.storeStock(principal, storeId);
    return this.deps.sales.movements(principal.brandId, storeId, { sku, limit: 50 });
  }

  /**
   * The brand's offline sales: every store's walk-in sales (invoices recorded in the Store
   * Console) beside its Qwikspot pickups, by store and by product. Values are the stores'
   * offline prices ("est." for pickups, priced from today's stock rows).
   */
  async brandSummary(brandId: string, days: number) {
    const now = this.now();
    const since = new Date(now.getTime() - days * DAY_MS).toISOString();
    const [sales, stores, completed, inventory] = await Promise.all([
      this.deps.sales.listByBrand(brandId, since),
      this.deps.stores.list(brandId),
      this.deps.reservations.list(brandId, { status: 'COMPLETED', limit: 1000 }),
      this.deps.inventory.listByBrand(brandId),
    ]);
    const recorded = sales.filter((s) => s.status === 'RECORDED');
    const price = new Map(inventory.map((r) => [`${r.storeId}|${r.canonicalSku}`, r.offlinePrice]));
    const pickups = completed.filter((r) => r.completedAt && r.completedAt >= since);
    const pickupValue = (r: (typeof pickups)[number]) =>
      (price.get(`${r.storeId}|${r.canonicalSku}`) ?? 0) * r.quantity;
    const name = new Map(stores.map((s) => [s.storeId, s.storeName]));

    const byStore = new Map<
      string,
      {
        store_id: string;
        store_name: string;
        invoices: number;
        units: number;
        value: number;
        pickups: number;
        pickup_value: number;
      }
    >();
    const row = (storeId: string) => {
      let r = byStore.get(storeId);
      if (!r) {
        r = {
          store_id: storeId,
          store_name: name.get(storeId) ?? storeId,
          invoices: 0,
          units: 0,
          value: 0,
          pickups: 0,
          pickup_value: 0,
        };
        byStore.set(storeId, r);
      }
      return r;
    };
    for (const s of recorded) {
      const r = row(s.storeId);
      r.invoices += 1;
      r.units += s.units;
      r.value += s.total;
    }
    for (const p of pickups) {
      const r = row(p.storeId);
      r.pickups += 1;
      r.pickup_value += pickupValue(p);
    }
    const byProduct = new Map<
      string,
      { sku: string; product_title: string | null; variant_title: string | null; units: number; value: number }
    >();
    for (const s of recorded) {
      for (const l of s.lines) {
        const p = byProduct.get(l.sku) ?? {
          sku: l.sku,
          product_title: l.productTitle,
          variant_title: l.variantTitle,
          units: 0,
          value: 0,
        };
        p.units += l.quantity;
        p.value += l.lineTotal;
        byProduct.set(l.sku, p);
      }
    }
    const walkIn = totalsOf(sales);
    const pickupTotal = pickups.reduce((n, p) => n + pickupValue(p), 0);
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      period: { days, from: since, to: now.toISOString() },
      walk_in: walkIn,
      qwikspot_pickups: { pickups: pickups.length, value: round(pickupTotal), currency: 'INR' },
      /** The share of the stores' offline sales value that came through Qwikspot pickups. */
      qwikspot_share_pct:
        walkIn.value + pickupTotal > 0 ? Math.round((pickupTotal / (walkIn.value + pickupTotal)) * 100) : null,
      by_store: [...byStore.values()]
        .map((r) => ({ ...r, value: round(r.value), pickup_value: round(r.pickup_value) }))
        .sort((a, b) => b.value + b.pickup_value - (a.value + a.pickup_value)),
      by_product: [...byProduct.values()]
        .map((p) => ({ ...p, value: round(p.value) }))
        .sort((a, b) => b.units - a.units),
      recent: sales.slice(0, 50).map((s) => ({ ...saleJson(s), store_name: name.get(s.storeId) ?? s.storeId })),
    };
  }

  private audit(
    principal: RetailPrincipal,
    action: string,
    targetId: string,
    result: 'SUCCESS' | 'DENIED',
    reasonCode: string | null,
  ) {
    return this.deps.audit.recordBrandEvent({
      brandId: principal.brandId,
      actorType: 'USER',
      actorId: principal.userId,
      action,
      targetType: 'STORE_SALE',
      targetId,
      result,
      reasonCode,
    });
  }
}

/** Recorded sales only (voided ones are listed, never counted). */
function totalsOf(sales: StoreSaleRecord[]) {
  const recorded = sales.filter((s) => s.status === 'RECORDED');
  return {
    invoices: recorded.length,
    units: recorded.reduce((n, s) => n + s.units, 0),
    value: Math.round(recorded.reduce((n, s) => n + s.total, 0) * 100) / 100,
    voided: sales.length - recorded.length,
    currency: 'INR',
  };
}

/** A sale as the APIs return it: no user id of who recorded it, never a customer. */
export function saleJson(s: StoreSaleRecord) {
  return {
    sale_id: s.saleId,
    store_id: s.storeId,
    invoice_number: s.invoiceNumber,
    lines: s.lines.map((l) => ({
      sku: l.sku,
      product_title: l.productTitle,
      variant_title: l.variantTitle,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      line_total: l.lineTotal,
    })),
    units: s.units,
    total: s.total,
    currency: s.currency,
    payment_method: s.paymentMethod,
    status: s.status,
    created_at: s.createdAt,
    voided_at: s.voidedAt,
    void_reason: s.voidReason,
  };
}

export function movementJson(m: StockMovementRecord) {
  return {
    sku: m.sku,
    delta: m.delta,
    quantity_after: m.quantityAfter,
    reason: m.reason,
    invoice_number: m.invoiceNumber,
    at: m.at,
  };
}
