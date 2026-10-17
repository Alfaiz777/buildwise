import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { invoiceNumber, PAYMENT_METHODS, STOCK_CHANGE_REASONS, type SaleStock } from '../../domain/storeSale.js';
import { deriveAvailabilityStatus } from '../../domain/storeTruth.js';
import type {
  RecordSaleInput,
  RecordSaleResult,
  StockMovementRecord,
  StoreSaleRecord,
  StoreSaleRepository,
  VoidSaleResult,
} from '../../ports/storeSales.js';
import { inventoryIdFor } from './repositories.js';

/**
 * Walk-in sales in Firestore (Change 19): brands/{brand}/storeSales/{sale_id},
 * brands/{brand}/stockMovements/{movement_id} and one counter per store
 * (brands/{brand}/storeSaleCounters/{store_id}) for the invoice numbers. A sale reads and writes
 * the same retailInventory documents a Qwikspot hold does, inside one transaction, so the two can
 * never both take the last unit. Times are ISO strings; every query uses one field only (no
 * composite index to deploy) and filters the store in code.
 */
const SaleDoc = z.object({
  store_id: z.string(),
  invoice_number: z.string(),
  lines: z.array(
    z.object({
      sku: z.string(),
      canonical_sku: z.string(),
      variant_id: z.string(),
      product_title: z.string().nullable(),
      variant_title: z.string().nullable(),
      quantity: z.number(),
      unit_price: z.number(),
      line_total: z.number(),
    }),
  ),
  units: z.number(),
  total: z.number(),
  currency: z.string(),
  payment_method: z.enum(PAYMENT_METHODS),
  status: z.enum(['RECORDED', 'VOIDED']),
  created_at: z.string(),
  created_by: z.string(),
  voided_at: z.string().nullable().default(null),
  voided_by: z.string().nullable().default(null),
  void_reason: z.string().nullable().default(null),
});

const MovementDoc = z.object({
  store_id: z.string(),
  sku: z.string(),
  canonical_sku: z.string(),
  variant_id: z.string(),
  delta: z.number(),
  quantity_after: z.number(),
  reason: z.enum(STOCK_CHANGE_REASONS),
  sale_id: z.string(),
  invoice_number: z.string(),
  at: z.string(),
});

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

function toSale(brandId: string, id: string, data: unknown): StoreSaleRecord {
  const d = SaleDoc.parse(data);
  return {
    saleId: id,
    brandId,
    storeId: d.store_id,
    invoiceNumber: d.invoice_number,
    lines: d.lines.map((l) => ({
      sku: l.sku,
      canonicalSku: l.canonical_sku,
      variantId: l.variant_id,
      productTitle: l.product_title,
      variantTitle: l.variant_title,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      lineTotal: l.line_total,
    })),
    units: d.units,
    total: d.total,
    currency: d.currency,
    paymentMethod: d.payment_method,
    status: d.status,
    createdAt: d.created_at,
    createdBy: d.created_by,
    voidedAt: d.voided_at,
    voidedBy: d.voided_by,
    voidReason: d.void_reason,
  };
}

function saleDoc(s: StoreSaleRecord) {
  return {
    store_id: s.storeId,
    invoice_number: s.invoiceNumber,
    lines: s.lines.map((l) => ({
      sku: l.sku,
      canonical_sku: l.canonicalSku,
      variant_id: l.variantId,
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
    created_by: s.createdBy,
    voided_at: s.voidedAt,
    voided_by: s.voidedBy,
    void_reason: s.voidReason,
  };
}

export class FirestoreStoreSaleRepository implements StoreSaleRepository {
  constructor(private readonly db: Firestore) {}

  private brand(brandId: string) {
    return this.db.collection('brands').doc(brandId);
  }

  async record(input: RecordSaleInput): Promise<RecordSaleResult> {
    const brandRef = this.brand(input.brandId);
    const inventory = brandRef.collection('retailInventory');
    return this.db.runTransaction(async (tx): Promise<RecordSaleResult> => {
      // Reads first (Firestore transaction rule): the store's stock rows for these SKUs, the counter.
      const skus = [...new Set(input.lines.map((l) => l.sku))];
      const stockSnap = await tx.get(inventory.where('store_id', '==', input.storeId));
      const rows = stockSnap.docs
        .map((doc) => ({ ref: doc.ref, data: doc.data() }))
        .filter((r) => skus.includes(String(r.data.sku)));
      const counterRef = brandRef.collection('storeSaleCounters').doc(input.storeId);
      const counter = await tx.get(counterRef);
      const stock: SaleStock[] = rows.map((r) => ({
        sku: String(r.data.sku),
        canonicalSku: String(r.data.canonical_sku),
        variantId: String(r.data.variant_id),
        quantity: Number(r.data.quantity ?? 0),
        reservedQuantity: Number(r.data.reserved_quantity ?? 0),
        offlinePrice: Number(r.data.offline_price ?? 0),
      }));
      const check = input.check(input.lines, stock);
      if (!check.ok) return { status: 'REJECTED', check };

      const next = Number(counter.exists ? (counter.get('last') ?? 0) : 0) + 1;
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
        const s = stock.find((x) => x.sku === line.sku)!;
        const quantity = s.quantity - line.quantity;
        after.push({ sku: s.sku, quantity, reservedQuantity: s.reservedQuantity });
        tx.update(inventory.doc(inventoryIdFor(input.storeId, s.canonicalSku)), {
          quantity,
          availability_status: deriveAvailabilityStatus(quantity, s.reservedQuantity),
          last_updated_at: FieldValue.serverTimestamp(),
          last_change_reason: 'IN_STORE_SALE',
          last_change_at: input.at,
        });
        tx.create(brandRef.collection('stockMovements').doc(newId('mov')), {
          store_id: input.storeId,
          sku: s.sku,
          canonical_sku: s.canonicalSku,
          variant_id: s.variantId,
          delta: -line.quantity,
          quantity_after: quantity,
          reason: 'IN_STORE_SALE',
          sale_id: sale.saleId,
          invoice_number: sale.invoiceNumber,
          at: input.at,
        });
      }
      tx.set(counterRef, { last: next }, { merge: true });
      tx.create(brandRef.collection('storeSales').doc(sale.saleId), saleDoc(sale));
      return { status: 'RECORDED', sale, stock: after };
    });
  }

  async void(input: Parameters<StoreSaleRepository['void']>[0]): Promise<VoidSaleResult> {
    const brandRef = this.brand(input.brandId);
    const saleRef = brandRef.collection('storeSales').doc(input.saleId);
    return this.db.runTransaction(async (tx): Promise<VoidSaleResult> => {
      const snap = await tx.get(saleRef);
      if (!snap.exists) return { status: 'NOT_FOUND' };
      const sale = toSale(input.brandId, snap.id, snap.data());
      if (sale.storeId !== input.storeId) return { status: 'NOT_FOUND' };
      if (sale.status === 'VOIDED') return { status: 'ALREADY_VOIDED', sale };
      if (!input.allowed(sale.createdAt)) return { status: 'TOO_LATE', sale };
      const refs = sale.lines.map((l) =>
        brandRef.collection('retailInventory').doc(inventoryIdFor(sale.storeId, l.canonicalSku)),
      );
      const invSnaps = await Promise.all(refs.map((r) => tx.get(r)));
      sale.lines.forEach((l, i) => {
        const inv = invSnaps[i]!;
        if (!inv.exists) return; // the stock row was removed since (a new retail file): nothing to restore
        const quantity = Number(inv.get('quantity') ?? 0) + l.quantity;
        const reserved = Number(inv.get('reserved_quantity') ?? 0);
        tx.update(refs[i]!, {
          quantity,
          availability_status: deriveAvailabilityStatus(quantity, reserved),
          last_updated_at: FieldValue.serverTimestamp(),
          last_change_reason: 'SALE_VOIDED',
          last_change_at: input.at,
        });
        tx.create(brandRef.collection('stockMovements').doc(newId('mov')), {
          store_id: sale.storeId,
          sku: l.sku,
          canonical_sku: l.canonicalSku,
          variant_id: l.variantId,
          delta: l.quantity,
          quantity_after: quantity,
          reason: 'SALE_VOIDED',
          sale_id: sale.saleId,
          invoice_number: sale.invoiceNumber,
          at: input.at,
        });
      });
      const voided: StoreSaleRecord = {
        ...sale,
        status: 'VOIDED',
        voidedAt: input.at,
        voidedBy: input.by,
        voidReason: input.reason,
      };
      tx.update(saleRef, { status: 'VOIDED', voided_at: input.at, voided_by: input.by, void_reason: input.reason });
      return { status: 'VOIDED', sale: voided };
    });
  }

  async get(brandId: string, saleId: string) {
    const snap = await this.brand(brandId).collection('storeSales').doc(saleId).get();
    return snap.exists ? toSale(brandId, snap.id, snap.data()) : null;
  }

  private async since(brandId: string, since: string) {
    const snap = await this.brand(brandId)
      .collection('storeSales')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .get();
    return snap.docs.map((doc) => toSale(brandId, doc.id, doc.data()));
  }

  async listByStore(brandId: string, storeId: string, since: string) {
    return (await this.since(brandId, since)).filter((s) => s.storeId === storeId);
  }

  listByBrand(brandId: string, since: string) {
    return this.since(brandId, since);
  }

  async movements(brandId: string, storeId: string, options: { sku?: string; limit: number }) {
    // The last 90 days, by one field (no composite index); the store and SKU filtered here.
    const since = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();
    const snap = await this.brand(brandId)
      .collection('stockMovements')
      .where('at', '>=', since)
      .orderBy('at', 'desc')
      .get();
    return snap.docs
      .map((doc): StockMovementRecord => {
        const d = MovementDoc.parse(doc.data());
        return {
          movementId: doc.id,
          brandId,
          storeId: d.store_id,
          sku: d.sku,
          canonicalSku: d.canonical_sku,
          variantId: d.variant_id,
          delta: d.delta,
          quantityAfter: d.quantity_after,
          reason: d.reason,
          saleId: d.sale_id,
          invoiceNumber: d.invoice_number,
          at: d.at,
        };
      })
      .filter((m) => m.storeId === storeId && (!options.sku || m.sku === options.sku))
      .slice(0, options.limit);
  }
}
