import { createApp } from '../src/app.js';
import { AccountService } from '../src/application/accountService.js';
import { PlatformAdminService } from '../src/application/platformAdminService.js';
import { TenantAdminService } from '../src/application/tenantAdminService.js';
import type { TokenVerifier, VerifiedToken } from '../src/auth/tokenVerifier.js';
import { AppError, Errors } from '../src/lib/errors.js';
import { silentLogger, type Logger } from '../src/lib/logger.js';
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
  type NewUser,
  type PlatformAuditInput,
  type PlatformAuditRecord,
  type RetailerRecord,
  type RetailerRepository,
  type StoreRecord,
  type StoreRepository,
  type UserRecord,
  type UserRepository,
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
    const record = { ...brand, status: 'ACTIVE', createdAt: new Date().toISOString(), brandAdminUserId: null };
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

const brand = (brandId: string, brandAdminUserId: string | null, status = 'ACTIVE'): BrandRecord => ({
  brandId,
  name: `Brand ${brandId}`,
  status,
  createdAt: null,
  brandAdminUserId,
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
export function buildTestWorld(options: { corsAllowedOrigins?: string[]; logger?: Logger } = {}) {
  const world = seedWorld();
  const users = new MemoryUsers(world.users);
  const brands = new MemoryBrands(world.brands);
  const retailers = new MemoryRetailers(world.retailers);
  const stores = new MemoryStores(world.stores, world.retailers);
  const audit = new MemoryAudit();
  const identity = new FakeIdentity();
  for (const u of world.users) if (u.email) identity.byEmail.set(u.email, u.userId);

  const emailOf = (uid: string) => users.users.find((u) => u.userId === uid)?.email ?? null;
  const app = createApp({
    config: { corsAllowedOrigins: options.corsAllowedOrigins ?? [] },
    logger: options.logger ?? silentLogger,
    verifier: new FakeVerifier(emailOf),
    repositories: { users, brands, retailers, stores },
    services: {
      platformAdmin: new PlatformAdminService({ brands, users, identity, audit }),
      tenantAdmin: new TenantAdminService({ users, retailers, stores, identity, audit }),
      account: new AccountService(stores),
    },
  });
  return { app, world, users, brands, retailers, stores, audit, identity };
}

export const bearer = (userId: string) => `Bearer token-${userId}`;

export { AppError };
