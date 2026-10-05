import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { MockCommerceProvider } from '../src/adapters/commerce/mockCommerceProvider.js';
import type { AgentRuntime } from '../src/ports/agent.js';
import type { DemoConfig } from '../src/config/env.js';
import { MemoryReservations } from './memoryReservations.js';
import { MemoryInsightsReader } from './memoryInsights.js';
import { InsightsService } from '../src/application/insightsService.js';
import { CsvRetailFileParser } from '../src/adapters/retail/csvRetailFileParser.js';
import { SimulatorMessagingProvider } from '../src/adapters/messaging/simulatorMessagingProvider.js';
import { createConversationModule } from '../src/application/conversationModule.js';
import type { Channel } from '../src/domain/channels.js';
import type { CommerceEvent } from '../src/domain/events.js';
import type { MessagingProvider } from '../src/ports/messaging.js';
import {
  MemoryConversations,
  MemoryCustomers,
  MemoryEvents,
  MemoryAttributionRefs,
  MemoryIntents,
  MemoryOutcomes,
  MemoryReceipts,
  MemoryRecommendations,
  MemoryTokens,
  MemoryVisitors,
} from './memoryConversation.js';
import { createApp } from '../src/app.js';
import { AccountService } from '../src/application/accountService.js';
import { CatalogService } from '../src/application/catalogService.js';
import { CommerceSyncService } from '../src/application/commerceSyncService.js';
import { PlatformAdminService } from '../src/application/platformAdminService.js';
import { DemoResetService } from '../src/application/demoResetService.js';
import { BundledFixtureSource } from '../src/adapters/fixtures/bundledFixtureSource.js';
import type { DemoDataStore, DemoHistory } from '../src/ports/demoData.js';
import { RetailImportService } from '../src/application/retailImportService.js';
import { StoreService } from '../src/application/storeService.js';
import { TenantAdminService } from '../src/application/tenantAdminService.js';
import type { TokenVerifier, VerifiedToken } from '../src/auth/tokenVerifier.js';
import { AppError, Errors } from '../src/lib/errors.js';
import { silentLogger, type Logger } from '../src/lib/logger.js';
import type { CommerceProvider } from '../src/ports/commerce.js';
import type { FileStorageProvider, LocalUploadReceiver, PendingUpload } from '../src/ports/fileStorage.js';
import type { IdentityAdmin } from '../src/ports/identity.js';
import type { StoreAssignmentDecision, StoreAssignmentState } from '../src/domain/retailOwnership.js';
import {
  ConflictError,
  DomainConflictError,
  type AdminSlot,
  type AuditRepository,
  type BrandAuditInput,
  type BrandRecord,
  type BrandRepository,
  type ConnectionRecord,
  type ConnectionRepository,
  type InventoryRecord,
  type InventoryRepository,
  type InventoryUpsert,
  type MappingRecord,
  type MappingRepository,
  type NewUser,
  type PlatformAuditInput,
  type PlatformAuditRecord,
  type ProductRecord,
  type ProductRepository,
  type RetailerRecord,
  type RetailerRepository,
  type RetailImportCounts,
  type RetailImportRecord,
  type RetailImportRepository,
  type StoreImportFields,
  type StoreRecord,
  type StoreRepository,
  type UserRecord,
  type UserRepository,
  type VariantRecord,
} from '../src/ports/repositories.js';

/**
 * `token-<uid>` verifies as that uid (a real Firebase user). Special tokens
 * simulate failures. Anything else is invalid.
 */
export class FakeVerifier implements TokenVerifier {
  constructor(private readonly emails: (uid: string) => string | null) {}
  async verify(idToken: string): Promise<VerifiedToken> {
    if (idToken === 'expired-token') throw Errors.authExpired();
    if (idToken === 'firebase-down') throw Errors.authUnavailable();
    if (!idToken.startsWith('token-')) throw Errors.authInvalid();
    const uid = idToken.slice('token-'.length);
    return { uid, email: this.emails(uid) };
  }
}

export class MemoryUsers implements UserRepository {
  constructor(readonly users: UserRecord[]) {}
  async getById(userId: string) {
    return this.users.find((u) => u.userId === userId) ?? null;
  }
  async create(user: NewUser) {
    if (this.users.some((u) => u.userId === user.userId)) throw new ConflictError(`users/${user.userId}`);
    this.users.push({ ...user, status: 'ACTIVE' });
  }
  async listByBrand(brandId: string) {
    return this.users.filter((u) => u.brandId === brandId);
  }
}

/** In-memory equivalent of the transactional one-admin slot (single-threaded, so trivially atomic). */
function memorySlot(
  get: () => { holder: string | null; set(v: string | null): void; missingRequirement?: string } | null,
): AdminSlot {
  return {
    async claimAdmin(userId) {
      const target = get();
      if (!target) throw new Error('scope document missing');
      if (target.missingRequirement) throw new DomainConflictError(target.missingRequirement);
      if (target.holder && target.holder !== userId) throw new ConflictError('admin slot taken');
      target.set(userId);
    },
    async releaseAdmin(userId) {
      const target = get();
      if (target && target.holder === userId) target.set(null);
    },
  };
}

export class MemoryBrands implements BrandRepository {
  constructor(readonly brands: BrandRecord[]) {}
  async getById(brandId: string) {
    return this.brands.find((b) => b.brandId === brandId) ?? null;
  }
  async list() {
    return [...this.brands];
  }
  async create(brand: { brandId: string; name: string }) {
    const record = {
      ...brand,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      brandAdminUserId: null,
      settings: {},
    };
    this.brands.push(record);
    return record;
  }
  async setStatus(brandId: string, status: 'ACTIVE' | 'SUSPENDED') {
    const brand = this.brands.find((b) => b.brandId === brandId);
    if (brand) brand.status = status;
  }
  adminSlot(brandId: string) {
    return memorySlot(() => {
      const b = this.brands.find((x) => x.brandId === brandId);
      return b ? { holder: b.brandAdminUserId, set: (v) => (b.brandAdminUserId = v) } : null;
    });
  }
}

export class MemoryRetailers implements RetailerRepository {
  constructor(readonly retailers: RetailerRecord[]) {}
  async get(brandId: string, retailerId: string) {
    return this.retailers.find((r) => r.brandId === brandId && r.retailerId === retailerId) ?? null;
  }
  async list(brandId: string) {
    return this.retailers.filter((r) => r.brandId === brandId);
  }
  async create(r: { brandId: string; retailerId: string; name: string }) {
    const record = { ...r, status: 'ACTIVE' };
    this.retailers.push(record);
    return record;
  }
}

/** Mirrors the Firestore transaction: read state, ask the domain rule, apply to the store. */
export class MemoryStores implements StoreRepository {
  constructor(
    readonly stores: StoreRecord[],
    private readonly retailers: RetailerRecord[],
  ) {}
  private find(brandId: string, storeId: string) {
    return this.stores.find((s) => s.brandId === brandId && s.storeId === storeId) ?? null;
  }
  async get(brandId: string, storeId: string) {
    return this.find(brandId, storeId);
  }
  async list(brandId: string) {
    return this.stores.filter((s) => s.brandId === brandId);
  }
  async upsertFromImport(brandId: string, stores: StoreImportFields[]) {
    for (const fields of stores) {
      const existing = this.find(brandId, fields.storeId);
      if (existing) Object.assign(existing, fields);
      else this.stores.push({ ...fields, brandId, retailerId: null, retailAdminUserId: null });
    }
  }
  adminSlot(brandId: string, storeId: string) {
    return memorySlot(() => {
      const s = this.find(brandId, storeId);
      return s
        ? {
            holder: s.retailAdminUserId,
            set: (v) => (s.retailAdminUserId = v),
            missingRequirement: s.retailerId ? undefined : 'STORE_HAS_NO_RETAILER',
          }
        : null;
    });
  }
  async assignRetailer(
    brandId: string,
    storeId: string,
    retailerId: string | null,
    decide: (state: StoreAssignmentState) => StoreAssignmentDecision,
  ) {
    const store = this.find(brandId, storeId);
    const target =
      retailerId === null ? null : this.retailers.find((r) => r.brandId === brandId && r.retailerId === retailerId);
    const decision = decide({
      store: store ? { storeId, retailerId: store.retailerId, retailAdminUserId: store.retailAdminUserId } : null,
      target: target === null ? null : target ? { retailerId: target.retailerId } : undefined,
    });
    if (decision.ok && decision.change !== 'NONE') store!.retailerId = decision.change === 'ASSIGN' ? retailerId : null;
    return decision;
  }
}

const iso = () => new Date().toISOString();

export class MemoryProducts implements ProductRepository {
  readonly products: ProductRecord[] = [];
  readonly variants: VariantRecord[] = [];
  async listProducts(brandId: string) {
    return this.products.filter((p) => p.brandId === brandId);
  }
  async listVariants(brandId: string) {
    return this.variants.filter((v) => v.brandId === brandId);
  }
  async upsertCatalog(brandId: string, products: ProductRecord[], variants: VariantRecord[]) {
    const put = <T extends { brandId: string }>(list: T[], item: T, same: (x: T) => boolean) => {
      const i = list.findIndex((x) => x.brandId === brandId && same(x));
      if (i >= 0) list[i] = structuredClone(item);
      else list.push(structuredClone(item));
    };
    for (const p of products) put(this.products, p, (x) => x.productId === p.productId);
    for (const v of variants) put(this.variants, v, (x) => x.variantId === v.variantId);
  }
}

export class MemoryMappings implements MappingRepository {
  readonly mappings: MappingRecord[] = [];
  async list(brandId: string) {
    return this.mappings.filter((m) => m.brandId === brandId);
  }
  async upsertMany(brandId: string, mappings: MappingRecord[]) {
    for (const m of mappings) {
      const i = this.mappings.findIndex((x) => x.brandId === brandId && x.mappingId === m.mappingId);
      const record = { ...m, brandId, updatedAt: iso() };
      if (i >= 0) this.mappings[i] = record;
      else this.mappings.push(record);
    }
  }
}

export class MemoryInventory implements InventoryRepository {
  readonly rows: InventoryRecord[] = [];
  async listByBrand(brandId: string) {
    return this.rows.filter((r) => r.brandId === brandId);
  }
  async listByStore(brandId: string, storeId: string) {
    return this.rows.filter((r) => r.brandId === brandId && r.storeId === storeId);
  }
  async listByVariant(brandId: string, variantId: string) {
    return this.rows.filter((r) => r.brandId === brandId && r.variantId === variantId);
  }
  async upsertStock(brandId: string, rows: InventoryUpsert[], availabilityOf: (q: number, r: number) => string) {
    for (const row of rows) {
      const inventoryId = `${row.storeId}__${row.canonicalSku}`;
      const existing = this.rows.find((r) => r.brandId === brandId && r.inventoryId === inventoryId);
      const reservedQuantity = existing?.reservedQuantity ?? 0;
      const record: InventoryRecord = {
        ...row,
        inventoryId,
        brandId,
        reservedQuantity,
        availabilityStatus: availabilityOf(row.quantity, reservedQuantity),
        lastUpdatedAt: iso(),
      };
      if (existing) Object.assign(existing, record);
      else this.rows.push(record);
    }
  }
}

export class MemoryConnections implements ConnectionRepository {
  readonly connections: ConnectionRecord[] = [];
  async get(brandId: string, connectionId: string) {
    return this.connections.find((c) => c.brandId === brandId && c.connectionId === connectionId) ?? null;
  }
  async list(brandId: string) {
    return this.connections.filter((c) => c.brandId === brandId);
  }
  async put(connection: ConnectionRecord) {
    const i = this.connections.findIndex(
      (c) => c.brandId === connection.brandId && c.connectionId === connection.connectionId,
    );
    if (i >= 0) this.connections[i] = { ...connection };
    else this.connections.push({ ...connection });
  }
}

export class MemoryImports implements RetailImportRepository {
  readonly imports: RetailImportRecord[] = [];
  private find(brandId: string, importId: string) {
    return this.imports.find((r) => r.brandId === brandId && r.importId === importId) ?? null;
  }
  async create(record: RetailImportRecord) {
    this.imports.push({ ...record, createdAt: new Date(Date.now() + this.imports.length).toISOString() });
  }
  async get(brandId: string, importId: string) {
    const r = this.find(brandId, importId);
    return r ? { ...r } : null;
  }
  async list(brandId: string, limit: number) {
    return this.imports
      .filter((r) => r.brandId === brandId)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, limit);
  }
  async claimForProcessing(brandId: string, importId: string) {
    const r = this.find(brandId, importId);
    if (!r || r.status !== 'UPLOADED') return false;
    r.status = 'PROCESSING';
    return true;
  }
  async finish(
    brandId: string,
    importId: string,
    result: RetailImportCounts & {
      status: 'COMPLETED' | 'FAILED';
      failureCode: string | null;
      rowErrorsReference: string | null;
    },
  ) {
    Object.assign(this.find(brandId, importId)!, result, { completedAt: iso() });
  }
}

/** In-memory FileStorageProvider + local upload receiver (same contract as the local adapter). */
export class MemoryFiles implements FileStorageProvider, LocalUploadReceiver {
  readonly name = 'LOCAL' as const;
  readonly files = new Map<string, Buffer>();
  readonly pending = new Map<string, PendingUpload>();
  async createUploadTarget(key: string, contentType: string, maxBytes: number) {
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    this.pending.set(uploadId, { key, contentType, maxBytes, expiresAt });
    return {
      method: 'PUT' as const,
      url: `/api/local-files/uploads/${uploadId}`,
      headers: { 'Content-Type': contentType },
      expiresAt,
    };
  }
  describeUpload(uploadId: string) {
    return this.pending.get(uploadId) ?? null;
  }
  async acceptUpload(uploadId: string, body: Buffer) {
    const upload = this.pending.get(uploadId)!;
    this.files.set(upload.key, body);
    this.pending.delete(uploadId);
    return upload;
  }
  async openRead(key: string) {
    const body = this.files.get(key);
    if (!body) throw new Error('not found');
    return Readable.from([body]);
  }
  async write(key: string, body: string | Buffer, _contentType?: string) {
    this.files.set(key, Buffer.from(body));
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

export class MemoryAudit implements AuditRepository {
  readonly platformEvents: PlatformAuditRecord[] = [];
  readonly brandEvents: BrandAuditInput[] = [];
  async recordPlatformEvent(event: PlatformAuditInput) {
    this.platformEvents.push({ ...event, auditId: `pa_${this.platformEvents.length}`, timestamp: null });
    if (event.targetBrandId) {
      this.brandEvents.push({
        brandId: event.targetBrandId,
        actorType: 'PLATFORM_ADMIN',
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        result: event.result,
        reasonCode: event.reasonCode,
      });
    }
  }
  async recordBrandEvent(event: BrandAuditInput) {
    this.brandEvents.push(event);
  }
  async listPlatformEvents(limit: number) {
    return [...this.platformEvents].reverse().slice(0, limit);
  }
  /** The memory audit stores no timestamps: any event reads as activity at the test clock. */
  async latestBrandEventAt(brandId: string) {
    return this.brandEvents.some((e) => e.brandId === brandId) ? '2026-10-07T06:30:00.000Z' : null;
  }
}

export class FakeIdentity implements IdentityAdmin {
  readonly byEmail = new Map<string, string>();
  private next = 1;
  async findUidByEmail(email: string) {
    return this.byEmail.get(email) ?? null;
  }
  async createUser(email: string) {
    const uid = `new_uid_${this.next++}`;
    this.byEmail.set(email, uid);
    return uid;
  }
  async createPasswordSetupLink(email: string) {
    return `https://auth.example.test/reset?email=${encodeURIComponent(email)}`;
  }
}

/** Storefront origin allowed for every test brand (docs/04 §3). */
export const TEST_ORIGIN = 'http://shop.test';

/** Follow-up policy with the local demo delays (docs/04 §3). */
export const DEMO_FOLLOW_UP_POLICY = {
  inactivity_minutes: 1,
  frequency_hours: 24,
  types: {
    SEARCH_EXPLORATION: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
    PRODUCT_CONSIDERATION: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
    CART_ABANDONMENT: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
    CHECKOUT_ABANDONMENT: { enabled: true, delay_minutes: 1, priority: 'HIGH' },
    STORE_ORIENTED: { enabled: true, delay_minutes: 1, priority: 'NORMAL' },
  },
};

const brand = (brandId: string, brandAdminUserId: string | null, status = 'ACTIVE'): BrandRecord => ({
  brandId,
  name: `Brand ${brandId}`,
  status,
  createdAt: null,
  brandAdminUserId,
  settings: {
    allowed_storefront_origins: [TEST_ORIGIN],
    messaging: { display_name: `Brand ${brandId}`, whatsapp_number: '910000000000' },
    human_handoff_rules: { enabled: true },
    follow_up_policy: DEMO_FOLLOW_UP_POLICY,
  },
});
const retailer = (brandId: string, retailerId: string, status = 'ACTIVE'): RetailerRecord => ({
  brandId,
  retailerId,
  name: `Retailer ${retailerId}`,
  status,
});
const store = (
  brandId: string,
  storeId: string,
  retailerId: string | null,
  retailAdminUserId: string | null,
): StoreRecord => ({
  brandId,
  storeId,
  retailerId,
  storeName: `Store ${storeId}`,
  city: 'Mumbai',
  address: `${storeId} street, Mumbai`,
  storeStatus: 'ACTIVE',
  storeHours: { timezone: 'Asia/Kolkata', monday: '10:00-21:00' },
  retailAdminUserId,
  latitude: 19.07,
  longitude: 72.87,
  reservationAvailable: true,
  pickupAvailable: true,
});
const user = (userId: string, role: string, fields: Partial<UserRecord> = {}): UserRecord => ({
  userId,
  role,
  brandId: null,
  retailerId: null,
  storeId: null,
  email: `${userId}@example.test`,
  status: 'ACTIVE',
  ...fields,
});
const retailAdmin = (userId: string, brandId: string, retailerId: string, storeId: string) =>
  user(userId, 'RETAIL_ADMIN', { brandId, retailerId, storeId });

/**
 * MVP ownership: a retailer may own many stores; each store belongs to one retailer and
 * has at most one RETAIL_ADMIN, who operates only that store. One BRAND_ADMIN per brand.
 *
 * brand_A (admin_a)
 *   ├── rtl_A  (Retailer A, several stores)
 *   │     ├── store_A  ── radmin_A
 *   │     ├── store_B  ── radmin_B
 *   │     ├── store_C       (no Retail Admin yet)
 *   │     └── store_M  ── radmin_mismatch (whose user doc names rtl_X as its retailer)
 *   ├── rtl_X  ── store_X  ── radmin_X
 *   ├── rtl_off (INACTIVE) ── store_off ── radmin_off
 *   ├── rtl_empty            (no stores yet)
 *   └── store_free           (no retailer)
 * brand_B (admin_b): rtl_b ── store_b1 ── radmin_b
 * brand_C (no Brand Admin yet)       brand_S (SUSPENDED)
 */
export function seedWorld() {
  return {
    brands: [
      brand('brand_A', 'admin_a'),
      brand('brand_B', 'admin_b'),
      brand('brand_C', null),
      brand('brand_S', 'admin_suspended', 'SUSPENDED'),
    ],
    retailers: [
      retailer('brand_A', 'rtl_A'),
      retailer('brand_A', 'rtl_X'),
      retailer('brand_A', 'rtl_off', 'INACTIVE'),
      retailer('brand_A', 'rtl_empty'),
      retailer('brand_B', 'rtl_b'),
    ],
    stores: [
      store('brand_A', 'store_A', 'rtl_A', 'radmin_A'),
      store('brand_A', 'store_B', 'rtl_A', 'radmin_B'),
      store('brand_A', 'store_C', 'rtl_A', null),
      store('brand_A', 'store_M', 'rtl_A', 'radmin_mismatch'),
      store('brand_A', 'store_X', 'rtl_X', 'radmin_X'),
      store('brand_A', 'store_off', 'rtl_off', 'radmin_off'),
      store('brand_A', 'store_free', null, null),
      store('brand_B', 'store_b1', 'rtl_b', 'radmin_b'),
    ],
    users: [
      user('platform', 'PLATFORM_ADMIN'),
      user('admin_a', 'BRAND_ADMIN', { brandId: 'brand_A' }),
      retailAdmin('radmin_A', 'brand_A', 'rtl_A', 'store_A'),
      retailAdmin('radmin_B', 'brand_A', 'rtl_A', 'store_B'),
      retailAdmin('radmin_X', 'brand_A', 'rtl_X', 'store_X'),
      user('admin_b', 'BRAND_ADMIN', { brandId: 'brand_B' }),
      retailAdmin('radmin_b', 'brand_B', 'rtl_b', 'store_b1'),
      user('admin_suspended', 'BRAND_ADMIN', { brandId: 'brand_S' }),
      retailAdmin('radmin_off', 'brand_A', 'rtl_off', 'store_off'),
      user('disabled_a', 'BRAND_ADMIN', { brandId: 'brand_A', status: 'DISABLED' }),
      // Well-formed but NOT the admin of record (a second admin for the same scope):
      user('second_brand_admin', 'BRAND_ADMIN', { brandId: 'brand_A' }),
      retailAdmin('second_retail_admin', 'brand_A', 'rtl_A', 'store_A'),
      // Recorded admin of store_M (retailer rtl_A), but its user document claims rtl_X:
      retailAdmin('radmin_mismatch', 'brand_A', 'rtl_X', 'store_M'),
      // Misconfigured documents (must be rejected with 403 USER_MISCONFIGURED):
      user('badrole', 'SUPERUSER', { brandId: 'brand_A' }),
      user('customer_role', 'CUSTOMER', { brandId: 'brand_A' }),
      user('platform_with_brand', 'PLATFORM_ADMIN', { brandId: 'brand_A' }),
      user('wildcard_brand', 'BRAND_ADMIN', { brandId: 'ALL' }),
      user('brand_admin_with_retailer', 'BRAND_ADMIN', { brandId: 'brand_A', retailerId: 'rtl_A' }),
      user('retail_admin_without_retailer', 'RETAIL_ADMIN', { brandId: 'brand_A', storeId: 'store_A' }),
      user('retail_admin_without_brand', 'RETAIL_ADMIN', { retailerId: 'rtl_A', storeId: 'store_A' }),
      user('retail_admin_without_store', 'RETAIL_ADMIN', { brandId: 'brand_A', retailerId: 'rtl_A' }),
    ],
  };
}

/** A fresh, isolated app + in-memory state per call. */
export function buildTestWorld(
  options: {
    corsAllowedOrigins?: string[];
    logger?: Logger;
    commerce?: CommerceProvider;
    localUploads?: boolean;
    /** Customer channels wired (default: the simulator). */
    channels?: Channel[];
    /** Injected clock for the M4 services. */
    now?: () => Date;
    /** The local-only demo storefront (default on; off mimics the gcp profile). */
    demoStorefront?: boolean;
    /** M5: the agent runtime (default: MockAgentRuntime) and its per-message budget. */
    agent?: AgentRuntime;
    aiBudgetMs?: number;
    pickupCode?: () => string;
    /** M7: replace the simulator provider (e.g. one that fails) and the retry backoff. */
    simulatorProvider?: MessagingProvider;
    sendRetryDelaysMs?: readonly number[];
    /** M7: DEMO_MODE configuration (default off) and the execution profile reported by the app. */
    demo?: DemoConfig;
    profile?: 'local' | 'gcp';
  } = {},
) {
  const world = seedWorld();
  const users = new MemoryUsers(world.users);
  const brands = new MemoryBrands(world.brands);
  const retailers = new MemoryRetailers(world.retailers);
  const stores = new MemoryStores(world.stores, world.retailers);
  const audit = new MemoryAudit();
  const identity = new FakeIdentity();
  for (const u of world.users) if (u.email) identity.byEmail.set(u.email, u.userId);
  const products = new MemoryProducts();
  const mappings = new MemoryMappings();
  const inventory = new MemoryInventory();
  const connections = new MemoryConnections();
  const imports = new MemoryImports();
  const files = new MemoryFiles();
  const commerceSync = new CommerceSyncService({
    commerce: options.commerce ?? new MockCommerceProvider(),
    products,
    mappings,
    connections,
    audit,
  });
  const retailImports = new RetailImportService({
    files,
    parser: new CsvRetailFileParser(),
    imports,
    stores,
    retailers,
    products,
    mappings,
    inventory,
    audit,
  });

  const emailOf = (uid: string) => users.users.find((u) => u.userId === uid)?.email ?? null;
  const customers = new MemoryCustomers();
  const visitors = new MemoryVisitors();
  const intents = new MemoryIntents();
  const tokens = new MemoryTokens(intents);
  const conversations = new MemoryConversations();
  const recommendations = new MemoryRecommendations();
  const receipts = new MemoryReceipts();
  const events = new MemoryEvents();
  const reservations = new MemoryReservations({ brands, stores, inventory });
  const outcomes = new MemoryOutcomes();
  const attributionRefs = new MemoryAttributionRefs();
  const sunk: CommerceEvent[] = [];
  const messaging = new Map<Channel, MessagingProvider>();
  if ((options.channels ?? ['SIMULATOR']).includes('SIMULATOR'))
    messaging.set('SIMULATOR', options.simulatorProvider ?? new SimulatorMessagingProvider());
  const conversation = createConversationModule({
    brands,
    products,
    customers,
    visitors,
    intents,
    tokens,
    conversations,
    recommendations,
    receipts,
    events,
    audit,
    sink: { name: 'LOCAL', emit: async (batch) => void sunk.push(...batch) },
    messaging,
    stores,
    inventory,
    reservations,
    outcomes,
    attributionRefs,
    agent: options.agent ?? new MockAgentRuntime(),
    aiBudgetMs: options.aiBudgetMs,
    pickupCode: options.pickupCode,
    sendRetryDelaysMs: options.sendRetryDelaysMs ?? [0, 0],
    logger: options.logger,
    now: options.now,
    demoStorefront:
      options.demoStorefront === false ? undefined : { commerce: options.commerce ?? new MockCommerceProvider() },
    shopperChannel:
      options.demoStorefront === false
        ? undefined
        : {
            sessionSecret: 'test-shopper-session-secret-0123456789',
            brandAllowed:
              (options.profile ?? 'local') === 'local'
                ? () => true
                : (brandId: string) => (options.demo?.brandIds ?? []).includes(brandId),
          },
  });

  const demoData = new MemoryDemoData(brands);
  const demoReset = new DemoResetService({
    demo: options.demo ?? { enabled: false, brandIds: [], holdMinutes: 20 },
    data: demoData,
    fixtures: new BundledFixtureSource(),
    files,
    brands,
    stores,
    products,
    customers,
    commerceSync,
    retailImports,
    audit,
    now: options.now,
  });

  const app = createApp({
    config: {
      corsAllowedOrigins: options.corsAllowedOrigins ?? [],
      demo: options.demo,
      profile: options.profile ?? 'local',
    },
    logger: options.logger ?? silentLogger,
    verifier: new FakeVerifier(emailOf),
    repositories: { users, brands, retailers, stores },
    services: {
      platformAdmin: new PlatformAdminService({
        brands,
        users,
        identity,
        audit,
        stores,
        connections,
        mappings,
        inventory,
      }),
      tenantAdmin: new TenantAdminService({ users, retailers, stores, inventory, identity, audit }),
      account: new AccountService({ stores, inventory, products, brands, now: options.now }),
      commerceSync,
      catalog: new CatalogService({ products, mappings, inventory }),
      retailImports,
      intents: conversation.intents,
      simulator: conversation.simulator,
      conversations: conversation.queries,
      followUps: conversation.followUps,
      reservations: conversation.reservations,
      fulfilment: conversation.fulfilment,
      handoff: conversation.handoff,
      insights: new InsightsService({
        reader: new MemoryInsightsReader({ intents, conversations, recommendations, events, reservations, outcomes }),
        stores,
        retailers,
        products,
        now: options.now ?? (() => new Date()),
      }),
      demoStorefront: conversation.demoStorefront,
      shopper: conversation.shopper,
      demoReset,
    },
    localUploads: options.localUploads === false ? undefined : files,
  });
  return {
    app,
    world,
    users,
    brands,
    retailers,
    stores,
    audit,
    identity,
    products,
    mappings,
    inventory,
    connections,
    imports,
    files,
    commerceSync,
    retailImports,
    storeService: new StoreService({ stores, inventory }),
    customers,
    visitors,
    intents,
    tokens,
    conversations,
    recommendations,
    receipts,
    events,
    sunk,
    conversation,
    reservations,
    outcomes,
    attributionRefs,
    demoData,
    demoReset,
  };
}

/** The memory demo store records what a reset asked for; the Firestore store is tested on the emulator. */
export class MemoryDemoData implements DemoDataStore {
  readonly calls: string[] = [];
  constructor(private readonly brands: MemoryBrands) {}
  async wipe(brandId: string) {
    this.calls.push(`wipe:${brandId}`);
    return { customers: 0 };
  }
  async setSettings(brandId: string, settings: Record<string, unknown>) {
    this.calls.push(`settings:${brandId}`);
    const brand = this.brands.brands.find((b) => b.brandId === brandId);
    if (brand) brand.settings = settings;
  }
  async writeHistory(brandId: string, history: DemoHistory, customerIds: string[]) {
    this.calls.push(`history:${brandId}`);
    return { customers: customerIds.length, outcomes: history.outcomes.length };
  }
}

export const bearer = (userId: string) => `Bearer token-${userId}`;

export { AppError };
