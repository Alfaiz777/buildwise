/**
 * Reset demo (Change 14, G4): puts ONE allowlisted demo brand back into its seeded state.
 *
 * Allowed only when DEMO_MODE is on (else 404 — the feature does not exist), the brand is
 * in DEMO_BRAND_IDS (else 403) and the caller is that brand's BRAND_ADMIN (the route's
 * scope check). It never touches another brand: the store deletes inside brands/{brandId}
 * and the brand's own top-level tokens and receipts only.
 *
 * Steps: wipe → demo settings → catalogue sync → judge stock fixture import → synthetic
 * history → audit DEMO_RESET. Kept: the brand, retailers, stores and their Retail Admins,
 * users and the audit trail. Idempotent: running it twice leaves the same state.
 * `seed:demo` and `seed:live` call rebuild() so all three produce the same demo.
 */
import { DEMO_HISTORY_SEED, generateDemoHistory, type HistoryStore, type HistoryVariant } from './demoHistory.js';
import type { CommerceSyncService } from './commerceSyncService.js';
import type { RetailImportService } from './retailImportService.js';
import { demoBrandSettings } from './demoSetup.js';
import type { StoreHours } from '../domain/storeHours.js';
import { AppError, Errors } from '../lib/errors.js';
import type { CustomerRepository } from '../ports/conversationRepositories.js';
import type { DemoDataStore, FixtureSource } from '../ports/demoData.js';
import type { FileStorageProvider } from '../ports/fileStorage.js';
import type { AuditRepository, BrandRepository, ProductRepository, StoreRepository } from '../ports/repositories.js';

export const DEMO_RETAIL_FIXTURE = 'retail/demo-judge-retail.csv';

export interface DemoResetDeps {
  demo: { enabled: boolean; brandIds: string[]; holdMinutes: number };
  data: DemoDataStore;
  fixtures: FixtureSource;
  files: FileStorageProvider;
  brands: BrandRepository;
  stores: StoreRepository;
  products: ProductRepository;
  customers: CustomerRepository;
  commerceSync: CommerceSyncService;
  retailImports: RetailImportService;
  audit: AuditRepository;
  now?: () => Date;
}

export interface DemoResetActor {
  type: 'USER' | 'SYSTEM';
  id: string;
}

export interface DemoResetResult {
  brandId: string;
  deleted: Record<string, number>;
  catalog: { products: number; variants: number };
  stock: { status: string; rowsValid: number; rowsInvalid: number };
  history: Record<string, number>;
}

export class DemoResetService {
  private readonly now: () => Date;

  constructor(private readonly deps: DemoResetDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the Reset demo control should be offered to this brand. */
  availableFor(brandId: string): boolean {
    return this.deps.demo.enabled && this.deps.demo.brandIds.includes(brandId);
  }

  /** The Brand Admin's "Reset demo" (route: POST /api/brand/demo/reset). */
  async reset(brandId: string, actor: DemoResetActor): Promise<DemoResetResult> {
    if (!this.deps.demo.enabled) throw Errors.notFound();
    if (!this.deps.demo.brandIds.includes(brandId)) {
      await this.audit(brandId, actor, 'DENIED', 'BRAND_NOT_DEMO');
      throw new AppError(403, 'DEMO_RESET_NOT_ALLOWED', 'Only the shared demo brand can be reset.');
    }
    return this.rebuild(brandId, actor);
  }

  /** Wipe and rebuild without the caller checks — for the seed scripts only. */
  async rebuild(brandId: string, actor: DemoResetActor): Promise<DemoResetResult> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();

    const deleted = await this.deps.data.wipe(brandId);
    await this.deps.data.setSettings(
      brandId,
      demoBrandSettings({ current: brand.settings, brandName: brand.name, holdMinutes: this.deps.demo.holdMinutes }),
    );

    const connection = await this.deps.commerceSync.sync(brandId, actor);

    const { record } = await this.deps.retailImports.create(brandId, actor, 'demo-judge-retail.csv');
    await this.deps.files.write(record.fileKey, await this.deps.fixtures.read(DEMO_RETAIL_FIXTURE), 'text/csv');
    const report = await this.deps.retailImports.process(brandId, actor, record.importId);

    const history = await this.writeHistory(brandId);
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    await this.audit(brandId, actor, 'SUCCESS', `DELETED_${total}`);
    return {
      brandId,
      deleted,
      catalog: { products: connection.productCount, variants: connection.variantCount },
      stock: {
        status: report.record.status,
        rowsValid: report.record.rowsValid,
        rowsInvalid: report.record.rowsInvalid,
      },
      history,
    };
  }

  /** 4 weeks of flagged synthetic history (M6), built from the brand's own stores and catalogue. */
  async writeHistory(brandId: string): Promise<Record<string, number>> {
    const now = this.now();
    const [stores, products, variants] = await Promise.all([
      this.deps.stores.list(brandId),
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
    ]);
    const titles = new Map(products.map((p) => [p.productId, p.title]));
    const historyStores: HistoryStore[] = stores
      .filter((s) => s.city === 'Mumbai' && s.latitude !== null && s.longitude !== null && s.storeHours)
      .map((s) => ({
        storeId: s.storeId,
        storeName: s.storeName,
        city: s.city,
        address: s.address,
        retailerId: s.retailerId,
        latitude: s.latitude!,
        longitude: s.longitude!,
        storeHours: s.storeHours as StoreHours,
      }));
    const variant = (sku: string): HistoryVariant => {
      const v = variants.find((x) => x.sku === sku);
      if (!v || !v.canonicalSku) throw new Error(`demo history: variant ${sku} not synced`);
      return {
        variantId: v.variantId,
        productId: v.productId,
        productTitle: titles.get(v.productId) ?? sku,
        title: v.title,
        sku,
        canonicalSku: v.canonicalSku,
        price: v.price,
        currency: v.currency,
      };
    };
    const plan = generateDemoHistory({
      seed: DEMO_HISTORY_SEED,
      now,
      brandId,
      days: 28,
      stores: historyStores,
      serum30: variant('DBC-VCSERUM-30'),
      serum50: variant('DBC-VCSERUM-50'),
    });

    // Synthetic customers through the identity path; their IDs replace the hist:<ref> placeholders.
    let json = JSON.stringify(plan);
    const customerIds: string[] = [];
    for (const ref of plan.customerRefs) {
      const { customer } = await this.deps.customers.findOrCreateByIdentity(
        brandId,
        { channel: 'SIMULATOR', externalRef: `sim:${ref}` },
        { consentState: 'NOT_OPTED_IN', shopifyCustomerId: null, displayRef: `sim:${ref}` },
        now.toISOString(),
      );
      customerIds.push(customer.customerId);
      json = json.split(`"hist:${ref}"`).join(`"${customer.customerId}"`);
    }
    return this.deps.data.writeHistory(brandId, JSON.parse(json), customerIds);
  }

  private audit(brandId: string, actor: DemoResetActor, result: 'SUCCESS' | 'DENIED', reasonCode: string) {
    return this.deps.audit.recordBrandEvent({
      brandId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'DEMO_RESET',
      targetType: 'BRAND',
      targetId: brandId,
      result,
      reasonCode,
    });
  }
}
