import type { PlatformPrincipal } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { IdentityAdmin } from '../ports/identity.js';
import { isStockStale, resolveFreshnessHours, resolveMessagingSettings } from '../domain/brandSettings.js';
import {
  brandAggregate,
  storeHealth,
  sumAggregates,
  type NetworkLookup,
  type NetworkReservation,
  type NetworkStore,
} from '../domain/platformNetwork.js';
import type { InsightsReader } from '../ports/insights.js';
import type { ReservationRepository } from '../ports/reservations.js';
import type {
  AuditRepository,
  BrandRecord,
  BrandRepository,
  ConnectionRepository,
  InventoryRepository,
  MappingRepository,
  PlatformAuditRecord,
  RetailerRepository,
  StoreRepository,
  UserRepository,
} from '../ports/repositories.js';
import { provisionUser, type ProvisionedUser } from './provisioning.js';

export interface PlatformAdminDeps {
  brands: BrandRepository;
  users: UserRepository;
  identity: IdentityAdmin;
  audit: AuditRepository;
  /** M7 onboarding checklist: counts only, never customer data. */
  stores: StoreRepository;
  connections: ConnectionRepository;
  mappings: MappingRepository;
  inventory: InventoryRepository;
  /** UI-5 retail view (aggregates only): optional so older wiring keeps working. */
  reader?: InsightsReader;
  retailers?: RetailerRepository;
  reservations?: ReservationRepository;
  now?: () => Date;
}

export const NETWORK_PERIODS = [7, 28] as const;
export interface NetworkOptions {
  days: (typeof NETWORK_PERIODS)[number];
  includeHistory: boolean;
}

/** One brand's onboarding at a glance for the Platform Admin (counts and timestamps only). */
export interface BrandOverview {
  brand: BrandRecord;
  catalog: { synced: boolean; lastSyncAt: string | null; productCount: number; failed: boolean };
  stores: { total: number; withStock: number };
  mapping: { autoMatched: number; needsAttention: number };
  retailAdmins: { provisioned: number; storesWithRetailer: number };
  channel: { whatsappNumberConfigured: boolean };
  lastActivityAt: string | null;
}

/**
 * Platform-scope operations (docs/07_SECURITY_SPEC.md §4.2, docs/06_INTEGRATION_CONTRACTS.md §14.6).
 * Every state change writes a PlatformAuditEvent (+ the brand's mirrored AuditEvent).
 * Nothing here reads customer data or conversations.
 */
export class PlatformAdminService {
  constructor(private readonly deps: PlatformAdminDeps) {}

  listBrands(): Promise<BrandRecord[]> {
    return this.deps.brands.list();
  }

  /** Every brand with its onboarding checklist and last activity (docs/06 §14.6, M7). */
  async overview(): Promise<BrandOverview[]> {
    const brands = await this.deps.brands.list();
    return Promise.all(brands.map((b) => this.brandOverview(b)));
  }

  private async brandOverview(brand: BrandRecord): Promise<BrandOverview> {
    const { stores, connections, mappings, inventory, audit } = this.deps;
    const [storeList, connectionList, mappingList, stock, lastActivityAt] = await Promise.all([
      stores.list(brand.brandId),
      connections.list(brand.brandId),
      mappings.list(brand.brandId),
      inventory.listByBrand(brand.brandId),
      audit.latestBrandEventAt(brand.brandId),
    ]);
    const commerce = connectionList.find((c) => c.provider === 'SHOPIFY') ?? null;
    const stocked = new Set(stock.map((r) => r.storeId));
    const owned = storeList.filter((s) => s.retailerId);
    return {
      brand,
      catalog: {
        synced: commerce?.status === 'CONNECTED' && !!commerce.lastSyncAt,
        lastSyncAt: commerce?.lastSyncAt ?? null,
        productCount: commerce?.productCount ?? 0,
        failed: commerce?.status === 'ERROR',
      },
      stores: { total: storeList.length, withStock: storeList.filter((s) => stocked.has(s.storeId)).length },
      mapping: {
        autoMatched: mappingList.filter((m) => m.mappingStatus === 'AUTO_MATCHED').length,
        needsAttention: mappingList.filter((m) => m.mappingStatus !== 'AUTO_MATCHED').length,
      },
      retailAdmins: { provisioned: owned.filter((s) => s.retailAdminUserId).length, storesWithRetailer: owned.length },
      channel: { whatsappNumberConfigured: !!resolveMessagingSettings(brand.settings, brand.name).whatsappNumber },
      lastActivityAt,
    };
  }

  async createBrand(actor: PlatformPrincipal, name: string): Promise<BrandRecord> {
    const brand = await this.deps.brands.create({ brandId: newId('brd'), name: name.trim() });
    await this.deps.audit.recordPlatformEvent({
      actorId: actor.userId,
      action: 'BRAND_CREATED',
      targetBrandId: brand.brandId,
      targetType: 'BRAND',
      targetId: brand.brandId,
      result: 'SUCCESS',
      reasonCode: null,
    });
    return brand;
  }

  async setBrandStatus(
    actor: PlatformPrincipal,
    brandId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string | null,
  ): Promise<BrandRecord> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();
    await this.deps.brands.setStatus(brandId, status);
    await this.deps.audit.recordPlatformEvent({
      actorId: actor.userId,
      action: status === 'SUSPENDED' ? 'BRAND_SUSPENDED' : 'BRAND_REACTIVATED',
      targetBrandId: brandId,
      targetType: 'BRAND',
      targetId: brandId,
      result: 'SUCCESS',
      reasonCode: reason,
    });
    return { ...brand, status };
  }

  async provisionBrandAdmin(actor: PlatformPrincipal, brandId: string, email: string): Promise<ProvisionedUser> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();
    const user = await provisionUser(
      this.deps,
      { email, role: 'BRAND_ADMIN', brandId, retailerId: null, storeId: null },
      {
        slot: this.deps.brands.adminSlot(brandId),
        currentHolder: brand.brandAdminUserId,
        conflictCode: 'BRAND_ADMIN_ALREADY_PROVISIONED',
        conflictMessage: 'This brand already has its Brand Admin. The MVP allows exactly one per brand.',
      },
    );
    await this.deps.audit.recordPlatformEvent({
      actorId: actor.userId,
      action: 'BRAND_ADMIN_PROVISIONED',
      targetBrandId: brandId,
      targetType: 'USER',
      targetId: user.userId,
      result: 'SUCCESS',
      reasonCode: null,
    });
    return user;
  }

  listAudit(limit = 50): Promise<PlatformAuditRecord[]> {
    return this.deps.audit.listPlatformEvents(limit);
  }

  // ---------------------------------------------------------------- UI-5 retail view

  /**
   * One brand's records for the retail view, reduced at once to count-able shapes: no
   * customer, message, pickup code or person ever leaves this method.
   */
  private async brandRecords(brand: BrandRecord, options: NetworkOptions) {
    const { reader, retailers, reservations, stores, inventory } = this.deps;
    if (!reader || !retailers || !reservations) throw Errors.notFound();
    const now = (this.deps.now ?? (() => new Date()))();
    const fromIso = new Date(now.getTime() - options.days * 24 * 60 * 60_000).toISOString();
    const [read, storeList, retailerList, stock, holds] = await Promise.all([
      reader.read(brand.brandId, { fromIso, toIso: now.toISOString(), includeHistory: options.includeHistory }),
      stores.list(brand.brandId),
      retailers.list(brand.brandId),
      inventory.listByBrand(brand.brandId),
      reservations.list(brand.brandId, { limit: 5000 }),
    ]);
    const freshness = resolveFreshnessHours(brand.settings);
    const networkStores: NetworkStore[] = storeList.map((s) => {
      const rows = stock.filter((r) => r.storeId === s.storeId);
      const updatedAt =
        rows
          .map((r) => r.lastUpdatedAt ?? '')
          .sort()
          .at(-1) || null;
      return {
        storeId: s.storeId,
        storeName: s.storeName,
        city: s.city,
        status: s.storeStatus,
        retailerId: s.retailerId,
        storeAdminProvisioned: !!s.retailAdminUserId,
        stock: { skuCount: rows.length, updatedAt, stale: rows.length > 0 && isStockStale(updatedAt, now, freshness) },
      };
    });
    const toHold = (r: (typeof holds)[number]): NetworkReservation => ({
      storeId: r.storeId,
      sku: r.sku,
      quantity: r.quantity,
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      cancelledBy: r.cancelledBy,
      cancelReason: r.cancelReason,
    });
    const periodHolds = holds
      .filter((r) => r.createdAt >= fromIso && (options.includeHistory || !r.demoHistory))
      .map(toHold);
    const activeHolds = holds.filter((r) => !r.demoHistory).map(toHold);
    const lookups: NetworkLookup[] = read.rows.lookups.map((l) => ({
      kind: l.kind,
      nearestStoreId: l.nearestStoreId,
      nearestReason: l.nearestReason,
    }));
    const price = new Map(stock.map((r) => [`${r.storeId}|${r.sku}`, r.offlinePrice]));
    const aggregate = brandAggregate({
      stores: networkStores,
      periodHolds,
      lookups,
      outcomes: read.rows.outcomes,
      followUpsSent: read.rows.intents.filter((i) => i.followUpSentAt).length,
      offlinePrice: (storeId, sku) => price.get(`${storeId}|${sku}`) ?? null,
      currency: 'INR',
    });
    const storeRows = networkStores.map((store) => storeHealth({ store, periodHolds, activeHolds, lookups, now }));
    const nearest = lookups.filter((l) => l.nearestStoreId !== null);
    return {
      now,
      fromIso,
      historyRecords: read.historyRecords,
      retailers: retailerList,
      storeRows,
      aggregate,
      parts: {
        finished: periodHolds.filter((r) => !['PENDING', 'CONFIRMED', 'READY', 'CUSTOMER_ARRIVED'].includes(r.status))
          .length,
        nearest: nearest.length,
        nearestHadStock: nearest.filter((l) => l.nearestReason === null).length,
      },
    };
  }

  /** GET /api/platform/network: platform totals and one aggregate row per brand. */
  async network(options: NetworkOptions) {
    const brands = await this.deps.brands.list();
    const per = await Promise.all(
      brands.map(async (brand) => ({
        brand,
        records: await this.brandRecords(brand, options),
        lastActivityAt: await this.deps.audit.latestBrandEventAt(brand.brandId),
      })),
    );
    const now = (this.deps.now ?? (() => new Date()))();
    const active = per.filter((p) => p.brand.status === 'ACTIVE');
    return {
      period: {
        days: options.days,
        from: new Date(now.getTime() - options.days * 24 * 60 * 60_000).toISOString(),
        to: now.toISOString(),
      },
      demo_history: {
        included: options.includeHistory,
        records: per.reduce((s, p) => s + p.records.historyRecords, 0),
      },
      totals: {
        brands_active: active.length,
        retailers: active.reduce((s, p) => s + p.records.retailers.length, 0),
        ...sumAggregates(per.map((p) => ({ aggregate: p.records.aggregate, ...p.records.parts }))),
      },
      brands: per.map((p) => ({
        brand_id: p.brand.brandId,
        name: p.brand.name,
        status: p.brand.status,
        ...p.records.aggregate,
        stores_flagged: p.records.storeRows.filter((s) => s.flags.length > 0).length,
        last_activity_at: p.lastActivityAt,
      })),
    };
  }

  /** GET /api/platform/brands/:brandId/network: retailers → stores, counts and flags only. */
  async brandNetwork(brandId: string, options: NetworkOptions) {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();
    const r = await this.brandRecords(brand, options);
    const storeRetailer = new Map(
      (await this.deps.stores.list(brandId)).map((s) => [s.storeId, s.retailerId ?? null] as const),
    );
    const known = new Set(r.retailers.map((x) => x.retailerId));
    return {
      brand_id: brand.brandId,
      name: brand.name,
      status: brand.status,
      period: { days: options.days, from: r.fromIso, to: r.now.toISOString() },
      demo_history: { included: options.includeHistory },
      retailers: r.retailers.map((ret) => ({
        retailer_id: ret.retailerId,
        name: ret.name,
        status: ret.status,
        stores: r.storeRows.filter((row) => storeRetailer.get(row.store_id) === ret.retailerId),
      })),
      unassigned_stores: r.storeRows.filter((row) => !known.has(storeRetailer.get(row.store_id) ?? '')),
    };
  }

  /** The audit list with the brand's name and the actor's role (never an email). */
  async auditView(limit: number) {
    const [events, brands] = await Promise.all([this.deps.audit.listPlatformEvents(limit), this.deps.brands.list()]);
    const names = new Map(brands.map((b) => [b.brandId, b.name]));
    const actors = [...new Set(events.map((e) => e.actorId))];
    const users = await Promise.all(actors.map((id) => this.deps.users.getById(id).catch(() => null)));
    const roles = new Map(actors.map((id, i) => [id, users[i]?.role ?? null]));
    return events.map((e) => ({
      ...e,
      targetBrandName: e.targetBrandId ? (names.get(e.targetBrandId) ?? null) : null,
      actorRole: roles.get(e.actorId) ?? 'SYSTEM',
    }));
  }
}
