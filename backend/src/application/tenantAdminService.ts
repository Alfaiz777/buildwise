import type { BrandPrincipal } from '../domain/principal.js';
import { decideStoreAssignment } from '../domain/retailOwnership.js';
import { AppError, Errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { IdentityAdmin } from '../ports/identity.js';
import type {
  AuditRepository,
  RetailerRecord,
  RetailerRepository,
  StoreRecord,
  StoreRepository,
  UserRecord,
  UserRepository,
} from '../ports/repositories.js';
import { provisionUser, type ProvisionedUser } from './provisioning.js';

export interface TenantAdminDeps {
  users: UserRepository;
  retailers: RetailerRepository;
  stores: StoreRepository;
  identity: IdentityAdmin;
  audit: AuditRepository;
}

const ALREADY_PROVISIONED = 'This store already has its Retail Admin. Each store has at most one.';

const ASSIGNMENT_ERRORS: Record<string, () => AppError> = {
  STORE_NOT_FOUND: Errors.notFound,
  RETAILER_NOT_FOUND: Errors.notFound,
  STORE_ALREADY_ASSIGNED: () =>
    Errors.conflict(
      'STORE_ALREADY_ASSIGNED',
      'This store already belongs to another retailer. A store belongs to exactly one retailer.',
    ),
  STORE_HAS_ADMIN: () =>
    Errors.conflict('STORE_HAS_ADMIN', 'This store is operated by its Retail Admin and cannot be unassigned.'),
};

/**
 * Brand administration by the brand's single BRAND_ADMIN (docs/06_INTEGRATION_CONTRACTS.md §14.7).
 * Every method works inside principal.brandId only, and every change is audited.
 *
 * MVP retail ownership (docs/04_DATA_MODEL.md §8a): a retailer may own many stores; each
 * store belongs to exactly one retailer and has at most one RETAIL_ADMIN, who operates
 * exactly that store. Retail Admin provisioning is therefore store-based. There are no
 * store-staff roles and no multi-store Retail Admins.
 */
export class TenantAdminService {
  constructor(private readonly deps: TenantAdminDeps) {}

  private audit(principal: BrandPrincipal, action: string, targetType: string, targetId: string) {
    return this.deps.audit.recordBrandEvent({
      brandId: principal.brandId,
      actorType: 'USER',
      actorId: principal.userId,
      action,
      targetType,
      targetId,
      result: 'SUCCESS',
      reasonCode: null,
    });
  }

  /**
   * Read-only view of the brand's console accounts: its single BRAND_ADMIN and its
   * stores' RETAIL_ADMINs. A BRAND_ADMIN is provisioned only by PLATFORM_ADMIN;
   * this service deliberately has no way to create one.
   */
  listUsers(principal: BrandPrincipal): Promise<UserRecord[]> {
    return this.deps.users.listByBrand(principal.brandId);
  }

  listRetailers(principal: BrandPrincipal): Promise<RetailerRecord[]> {
    return this.deps.retailers.list(principal.brandId);
  }

  /** The brand's stores (from the retail/store data flow), each with its retailer and Retail Admin. */
  listStores(principal: BrandPrincipal): Promise<StoreRecord[]> {
    return this.deps.stores.list(principal.brandId);
  }

  async createRetailer(principal: BrandPrincipal, name: string): Promise<RetailerRecord> {
    const retailer = await this.deps.retailers.create({
      brandId: principal.brandId,
      retailerId: newId('rtl'),
      name: name.trim(),
    });
    await this.audit(principal, 'RETAILER_CREATED', 'RETAILER', retailer.retailerId);
    return retailer;
  }

  /**
   * Provisions the single RETAIL_ADMIN of one store. The user's brand, retailer and
   * store all come from the store record, never from the client.
   */
  async createRetailAdmin(principal: BrandPrincipal, storeId: string, email: string): Promise<ProvisionedUser> {
    const store = await this.deps.stores.get(principal.brandId, storeId);
    if (!store) throw Errors.notFound();
    if (store.retailAdminUserId) throw Errors.conflict('RETAIL_ADMIN_ALREADY_PROVISIONED', ALREADY_PROVISIONED);
    const retailer = store.retailerId ? await this.deps.retailers.get(principal.brandId, store.retailerId) : null;
    if (!retailer) {
      throw Errors.conflict('STORE_HAS_NO_RETAILER', 'This store does not belong to a retailer yet.');
    }
    const user = await provisionUser(
      this.deps,
      { email, role: 'RETAIL_ADMIN', brandId: principal.brandId, retailerId: retailer.retailerId, storeId },
      {
        slot: this.deps.stores.adminSlot(principal.brandId, storeId),
        currentHolder: store.retailAdminUserId,
        conflictCode: 'RETAIL_ADMIN_ALREADY_PROVISIONED',
        conflictMessage: ALREADY_PROVISIONED,
      },
    );
    await this.audit(principal, 'RETAIL_ADMIN_PROVISIONED', 'USER', user.userId);
    return user;
  }

  /**
   * Associates a store with a retailer (or removes the association), atomically and
   * under the one-store ↔ one-retailer rule (domain/retailOwnership.ts). A retailer may
   * own many stores. Backend-only in M2 (no console UI): stores and their retailer arrive
   * with retail ingestion (M4), where retailer_id comes from the retail file
   * (docs/04_DATA_MODEL.md §9.1).
   */
  async assignStoreRetailer(
    principal: BrandPrincipal,
    storeId: string,
    retailerId: string | null,
  ): Promise<StoreRecord> {
    const decision = await this.deps.stores.assignRetailer(
      principal.brandId,
      storeId,
      retailerId,
      decideStoreAssignment,
    );
    if (!decision.ok) throw (ASSIGNMENT_ERRORS[decision.code] ?? (() => Errors.conflict(decision.code, 'Conflict.')))();
    if (decision.change !== 'NONE') {
      await this.audit(
        principal,
        decision.change === 'ASSIGN' ? 'STORE_RETAILER_ASSIGNED' : 'STORE_RETAILER_UNASSIGNED',
        'STORE',
        storeId,
      );
    }
    return (await this.deps.stores.get(principal.brandId, storeId))!;
  }
}
