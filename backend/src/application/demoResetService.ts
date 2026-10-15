/**
 * Reset demo (Change 14, G4): puts ONE allowlisted demo brand back into its seeded state.
 *
 * Allowed only when DEMO_MODE is on (else 404 — the feature does not exist), the brand is
 * in DEMO_BRAND_IDS (else 403) and the caller is that brand's BRAND_ADMIN (the route's
 * scope check). It never touches another brand: the store deletes inside brands/{brandId}
 * and the brand's own top-level tokens and receipts only.
 *
 * Steps: wipe → demo settings → catalogue sync → judge stock fixture import → synthetic
 * history → audit DEMO_RESET. Kept: the brand, the demo retailer, the fixture's stores and their
 * Retail Admins, users and the audit trail. L5: the old store network is removed (cleanUpNetwork). Idempotent: running it twice leaves the same state.
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
import type {
  AuditRepository,
  BrandRepository,
  InventoryRepository,
  ProductRepository,
  RetailerRepository,
  StoreRepository,
} from '../ports/repositories.js';

export const DEMO_RETAIL_FIXTURE = 'retail/demo-judge-retail.csv';
/** L5: the demo brand's one retailer — the id the stock fixture names, and its name everywhere. */
export const DEMO_RETAILER = { id: 'rtl_north', name: 'Ahmedabad Retail Partners' } as const;

/** What Reset demo removed or changed in the store network (L5). */
export interface NetworkCleanup {
  storesDeleted: string[];
  /** Old stores kept INACTIVE because they have a Retail Admin. */
  storesRetired: string[];
  retailersDeleted: string[];
  retailerRenamed: { retailerId: string; from: string; to: string } | null;
  stockRowsDeleted?: number;
}

export interface DemoResetDeps {
  demo: { enabled: boolean; brandIds: string[]; holdMinutes: number };
  data: DemoDataStore;
  fixtures: FixtureSource;
  files: FileStorageProvider;
  brands: BrandRepository;
  stores: StoreRepository;
  retailers: RetailerRepository;
  inventory: InventoryRepository;
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
  /** L5: the old network removed (stores, retailers) and the retailer renamed. */
  network: NetworkCleanup;
  /**
   * L1: SHOPIFY_NOT_CONNECTED when the brand's Shopify store is not connected yet — the brand,
   * its settings and stores are rebuilt, the catalogue and synthetic history are not. Connect
   * the store (Settings → Shopify), then Reset demo again.
   */
  pending: 'SHOPIFY_NOT_CONNECTED' | null;
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

    // L1: a fresh gcp project has no Shopify connection yet (it needs this brand's Brand Admin).
    // Still rebuild the stores from the stock file, so the store admins can be provisioned.
    let connection: Awaited<ReturnType<CommerceSyncService['sync']>> | null = null;
    try {
      connection = await this.deps.commerceSync.sync(brandId, actor);
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'SHOPIFY_NOT_CONNECTED')) throw err;
    }

    const { record } = await this.deps.retailImports.create(brandId, actor, 'demo-judge-retail.csv');
    await this.deps.files.write(record.fileKey, await this.deps.fixtures.read(DEMO_RETAIL_FIXTURE), 'text/csv');
    const report = await this.deps.retailImports.process(brandId, actor, record.importId);
    const network = await this.cleanUpNetwork(brandId);
    if (network.storesDeleted.length) deleted.stores = network.storesDeleted.length;
    if (network.retailersDeleted.length) deleted.retailers = network.retailersDeleted.length;
    if (network.stockRowsDeleted) deleted.retailInventory = (deleted.retailInventory ?? 0) + network.stockRowsDeleted;

    const history = connection ? await this.writeHistory(brandId) : {};
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    const reason = [
      connection ? `DELETED_${total}` : `DELETED_${total}_NO_CATALOG`,
      ...(network.storesDeleted.length ? [`stores_deleted=${network.storesDeleted.join(',')}`] : []),
      ...(network.storesRetired.length ? [`stores_inactive=${network.storesRetired.join(',')}`] : []),
      ...(network.retailersDeleted.length ? [`retailers_deleted=${network.retailersDeleted.join(',')}`] : []),
      ...(network.retailerRenamed ? [`retailer_renamed=${network.retailerRenamed.retailerId}`] : []),
    ].join(';');
    await this.audit(brandId, actor, 'SUCCESS', reason);
    return {
      brandId,
      deleted,
      network,
      pending: connection ? null : 'SHOPIFY_NOT_CONNECTED',
      catalog: { products: connection?.productCount ?? 0, variants: connection?.variantCount ?? 0 },
      stock: {
        status: report.record.status,
        rowsValid: report.record.rowsValid,
        rowsInvalid: report.record.rowsInvalid,
      },
      history,
    };
  }

  /**
   * L5: the demo network is exactly the fixture's area stores (Satellite, Navrangpura) under one
   * retailer. Runs after the stock import, and only once the import has created area stores:
   *   - a store without an area and without a Retail Admin is deleted, with its stock rows;
   *   - a store without an area that HAS a Retail Admin is kept, INACTIVE (no login is orphaned);
   *   - a retailer left with no store is deleted;
   *   - the demo retailer gets its current name (its id, stores and admins never change).
   * Conversations, reservations and history were wiped before the import, so nothing else
   * still refers to a deleted store. Running it again changes nothing.
   */
  private async cleanUpNetwork(brandId: string): Promise<NetworkCleanup> {
    const out: NetworkCleanup = { storesDeleted: [], storesRetired: [], retailersDeleted: [], retailerRenamed: null };
    const stores = await this.deps.stores.list(brandId);
    if (!stores.some((s) => s.area)) return out;
    let stockRowsDeleted = 0;
    for (const s of stores.filter((x) => !x.area)) {
      if (!s.retailAdminUserId) {
        stockRowsDeleted += await this.deps.inventory.deleteByStore(brandId, s.storeId);
        if (await this.deps.stores.deleteIfUnclaimed(brandId, s.storeId)) {
          out.storesDeleted.push(s.storeId);
          continue;
        }
      }
      if (s.storeStatus !== 'INACTIVE') {
        await this.deps.stores.upsertFromImport(brandId, [
          {
            storeId: s.storeId,
            storeName: s.storeName,
            city: s.city,
            address: s.address ?? '',
            latitude: s.latitude ?? 0,
            longitude: s.longitude ?? 0,
            storeHours: s.storeHours ?? {},
            storeStatus: 'INACTIVE',
            reservationAvailable: s.reservationAvailable,
            pickupAvailable: s.pickupAvailable,
            area: null,
            shortName: s.shortName ?? null,
          },
        ]);
      }
      out.storesRetired.push(s.storeId);
    }
    out.stockRowsDeleted = stockRowsDeleted;

    const owners = new Set(
      (await this.deps.stores.list(brandId)).map((s) => s.retailerId).filter((id): id is string => !!id),
    );
    for (const r of await this.deps.retailers.list(brandId)) {
      if (r.retailerId === DEMO_RETAILER.id) {
        const from = r.name;
        if (
          from !== DEMO_RETAILER.name &&
          (await this.deps.retailers.rename(brandId, r.retailerId, DEMO_RETAILER.name))
        )
          out.retailerRenamed = { retailerId: r.retailerId, from, to: DEMO_RETAILER.name };
      } else if (!owners.has(r.retailerId) && (await this.deps.retailers.deleteIfEmpty(brandId, r.retailerId))) {
        out.retailersDeleted.push(r.retailerId);
      }
    }
    return out;
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
      .filter(
        (s) => s.storeStatus === 'ACTIVE' && s.area && s.latitude !== null && s.longitude !== null && s.storeHours,
      )
      .map((s) => ({
        storeId: s.storeId,
        storeName: s.storeName,
        city: s.city,
        address: s.address,
        retailerId: s.retailerId,
        latitude: s.latitude!,
        longitude: s.longitude!,
        storeHours: s.storeHours as StoreHours,
        area: s.area ?? null,
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
