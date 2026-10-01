import {
  conversionByAction,
  fillRate,
  funnel,
  suggestions,
  unmetDemand,
  weekdayPanel,
  weekdayReading,
  type InsightCatalog,
} from '../domain/insights.js';
import { primaryLocality } from '../domain/locality.js';
import type { InsightsReader } from '../ports/insights.js';
import type { ProductRepository, RetailerRepository, StoreRepository } from '../ports/repositories.js';

export const INSIGHT_PERIODS = [7, 28] as const;

/**
 * The Brand Console "Outcomes & insights" screen (docs/00 §11.8 Change 13, F8). Reads raw
 * records through the InsightsReader port and computes every panel with the pure domain
 * functions, so each number can be traced to stored records. Brand-scoped by the caller.
 */
export class InsightsService {
  constructor(
    private readonly deps: {
      reader: InsightsReader;
      stores: StoreRepository;
      retailers: RetailerRepository;
      products: ProductRepository;
      now: () => Date;
    },
  ) {}

  async catalog(brandId: string): Promise<InsightCatalog> {
    const [stores, retailers, products, variants] = await Promise.all([
      this.deps.stores.list(brandId),
      this.deps.retailers.list(brandId),
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
    ]);
    const retailerName = new Map(retailers.map((r) => [r.retailerId, r.name]));
    const productTitle = new Map(products.map((p) => [p.productId, p.title]));
    const timezones = stores.map((s) => s.storeHours?.timezone).filter((t): t is string => !!t);
    return {
      stores: stores.map((s) => ({
        storeId: s.storeId,
        storeName: s.storeName,
        locality: primaryLocality(s),
        retailerName: s.retailerId ? (retailerName.get(s.retailerId) ?? null) : null,
        timezone: s.storeHours?.timezone ?? timezones[0] ?? 'UTC',
      })),
      variants: variants.map((v) => ({
        variantId: v.variantId,
        sku: v.sku,
        label: `${productTitle.get(v.productId) ?? v.sku} ${v.title}`,
      })),
      defaultTimezone: timezones[0] ?? 'UTC',
    };
  }

  async panels(brandId: string, options: { days: (typeof INSIGHT_PERIODS)[number]; includeHistory: boolean }) {
    const now = this.deps.now();
    const fromIso = new Date(now.getTime() - options.days * 24 * 60 * 60_000).toISOString();
    const [{ rows, historyRecords }, catalog] = await Promise.all([
      this.deps.reader.read(brandId, { fromIso, toIso: now.toISOString(), includeHistory: options.includeHistory }),
      this.catalog(brandId),
    ]);
    return {
      period: { days: options.days, from: fromIso, to: now.toISOString(), timezone: catalog.defaultTimezone },
      demo_history: { included: options.includeHistory, records: historyRecords },
      funnel: funnel(rows),
      conversion_by_action: conversionByAction(rows),
      unmet_demand: unmetDemand(rows, catalog),
      weekday: { days: weekdayPanel(rows, catalog), reading: weekdayReading(rows, catalog) },
      fill_rate: fillRate(rows, catalog),
      suggestions: suggestions(rows, catalog, options.days),
    };
  }
}
