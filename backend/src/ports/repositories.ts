/**
 * Persistence ports. Firestore documents use the snake_case field names from
 * docs/04_DATA_MODEL.md; adapters/firestore maps them to these records.
 *
 * Tenant-scoped methods take a brandId. Callers must pass the brand ID of the
 * verified principal (or, for platform services, the explicitly named and
 * audited target brand) — never a client-supplied value.
 */
import type { Role } from '../domain/principal.js';
import type { StoreAssignmentDecision, StoreAssignmentState } from '../domain/retailOwnership.js';
import type { MappingStatus } from '../domain/skuMapping.js';

export type { MappingStatus };

export interface UserRecord {
  userId: string;
  /** Raw stored value; validated against ROLES during principal resolution. */
  role: string;
  brandId: string | null;
  retailerId: string | null;
  /** RETAIL_ADMIN only: the one store it operates. */
  storeId: string | null;
  email: string | null;
  status: string;
}

export interface NewUser {
  userId: string;
  role: Role;
  brandId: string | null;
  retailerId: string | null;
  storeId: string | null;
  email: string;
}

export interface UserRepository {
  /** users/{userId} — top-level: looked up before the brand is known. */
  getById(userId: string): Promise<UserRecord | null>;
  /** Fails with ConflictError if the document already exists. */
  create(user: NewUser): Promise<void>;
  listByBrand(brandId: string): Promise<UserRecord[]>;
}

export interface BrandRecord {
  brandId: string;
  name: string;
  status: string;
  createdAt: string | null;
  /** The brand's single BRAND_ADMIN (MVP: exactly one per brand), or null before provisioning. */
  brandAdminUserId: string | null;
  /** brand.settings (docs/04 §3), read through domain/brandSettings.ts. */
  settings: Record<string, unknown>;
}

/**
 * The "one admin per scope" slot. `claimAdmin` runs in a transaction and fails
 * with ConflictError if another user already holds the slot, so two concurrent
 * provisioning requests can never produce two admins.
 */
export interface AdminSlot {
  claimAdmin(userId: string): Promise<void>;
  /** Frees the slot only if `userId` holds it (used to roll back a failed provisioning). */
  releaseAdmin(userId: string): Promise<void>;
}

export interface BrandRepository {
  getById(brandId: string): Promise<BrandRecord | null>;
  list(): Promise<BrandRecord[]>;
  create(brand: { brandId: string; name: string }): Promise<BrandRecord>;
  setStatus(brandId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void>;
  adminSlot(brandId: string): AdminSlot;
}

export interface RetailerRecord {
  retailerId: string;
  brandId: string;
  name: string;
  status: string;
}

export interface RetailerRepository {
  get(brandId: string, retailerId: string): Promise<RetailerRecord | null>;
  list(brandId: string): Promise<RetailerRecord[]>;
  create(retailer: { brandId: string; retailerId: string; name: string }): Promise<RetailerRecord>;
}

export interface StoreRecord {
  storeId: string;
  brandId: string;
  retailerId: string | null;
  storeName: string;
  city: string;
  address: string | null;
  storeStatus: string;
  /** Structured store hours (docs/04_DATA_MODEL.md §9.2), if present. */
  storeHours: Record<string, string> | null;
  latitude: number | null;
  longitude: number | null;
  reservationAvailable: boolean;
  pickupAvailable: boolean;
  /** The store's single RETAIL_ADMIN (at most one per store), or null before provisioning. */
  retailAdminUserId: string | null;
}

/** Store fields a retail import may set. Never retailer_id or retail_admin_user_id. */
export interface StoreImportFields {
  storeId: string;
  storeName: string;
  city: string;
  address: string;
  latitude: number;
  longitude: number;
  storeHours: Record<string, string>;
  storeStatus: 'ACTIVE' | 'INACTIVE';
  reservationAvailable: boolean;
  pickupAvailable: boolean;
}

export interface StoreRepository {
  get(brandId: string, storeId: string): Promise<StoreRecord | null>;
  list(brandId: string): Promise<StoreRecord[]>;
  /**
   * Creates or updates stores from a retail import. New stores start with no retailer
   * and no Retail Admin; existing stores keep both (ownership changes only through
   * assignRetailer, admins only through provisioning).
   */
  upsertFromImport(brandId: string, stores: StoreImportFields[]): Promise<void>;
  /**
   * Store → retailer (un)assignment. The adapter reads the store and the target retailer
   * in one transaction, asks `decide` (a pure domain rule) and writes only if the
   * decision allows it. Returns the decision.
   */
  assignRetailer(
    brandId: string,
    storeId: string,
    retailerId: string | null,
    decide: (state: StoreAssignmentState) => StoreAssignmentDecision,
  ): Promise<StoreAssignmentDecision>;
  /**
   * The store's RETAIL_ADMIN slot. Claiming also requires the store to belong to a
   * retailer: it fails with DomainConflictError('STORE_HAS_NO_RETAILER') otherwise.
   */
  adminSlot(brandId: string, storeId: string): AdminSlot;
}

/** docs/04_DATA_MODEL.md §7 */
export interface ProductRecord {
  productId: string;
  brandId: string;
  canonicalProductId: string;
  shopifyProductId: string;
  title: string;
  description: string;
  category: string | null;
  status: string;
  tags: string[];
  attributes: Record<string, string>;
}

/** docs/04_DATA_MODEL.md §8 */
export interface VariantRecord {
  variantId: string;
  brandId: string;
  productId: string;
  shopifyVariantId: string;
  title: string;
  sku: string;
  /** Normalized SKU (domain/skuMapping.ts), or null when the catalogue SKU is unusable. */
  canonicalSku: string | null;
  barcode: string | null;
  price: number;
  currency: string;
  status: string;
}

export interface ProductRepository {
  listProducts(brandId: string): Promise<ProductRecord[]>;
  listVariants(brandId: string): Promise<VariantRecord[]>;
  /** Idempotent upsert by deterministic IDs: re-syncing updates, never duplicates. */
  upsertCatalog(brandId: string, products: ProductRecord[], variants: VariantRecord[]): Promise<void>;
}

/** docs/04_DATA_MODEL.md §8.1 */
export interface MappingRecord {
  mappingId: string;
  brandId: string;
  sourceSystem: 'SHOPIFY' | 'RETAIL_FILE';
  sourceIdentifier: string;
  canonicalSku: string | null;
  variantId: string | null;
  mappingStatus: MappingStatus;
  mappingReason: string;
  /** ISO-8601; set by the repository. */
  updatedAt: string | null;
}

export interface MappingRepository {
  list(brandId: string): Promise<MappingRecord[]>;
  upsertMany(brandId: string, mappings: MappingRecord[]): Promise<void>;
}

/** docs/04_DATA_MODEL.md §10 */
export interface InventoryRecord {
  inventoryId: string;
  brandId: string;
  storeId: string;
  sku: string;
  canonicalSku: string;
  variantId: string;
  quantity: number;
  reservedQuantity: number;
  offlinePrice: number;
  availabilityStatus: string;
  /** ISO-8601 */
  lastUpdatedAt: string | null;
}

export interface InventoryUpsert {
  storeId: string;
  sku: string;
  canonicalSku: string;
  variantId: string;
  quantity: number;
  offlinePrice: number;
}

export interface InventoryRepository {
  listByBrand(brandId: string): Promise<InventoryRecord[]>;
  listByStore(brandId: string, storeId: string): Promise<InventoryRecord[]>;
  listByVariant(brandId: string, variantId: string): Promise<InventoryRecord[]>;
  /**
   * Overwrites quantity / offline_price / availability_status / last_updated_at, and
   * NEVER reserved_quantity (docs/04 §10). `availabilityOf` is the pure domain rule,
   * applied to the stored reserved_quantity.
   */
  upsertStock(
    brandId: string,
    rows: InventoryUpsert[],
    availabilityOf: (quantity: number, reservedQuantity: number) => string,
  ): Promise<void>;
}

/** docs/04_DATA_MODEL.md §5 (credentials are never stored here). */
export interface ConnectionRecord {
  connectionId: string;
  brandId: string;
  provider: 'SHOPIFY' | 'WHATSAPP' | 'RETAIL_FILE';
  /** Which adapter served the data (MOCK locally, SHOPIFY live). */
  source: string;
  status: 'CONNECTED' | 'ERROR';
  /** ISO-8601 */
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: { code: string; message: string } | null;
  productCount: number;
  variantCount: number;
}

export interface ConnectionRepository {
  get(brandId: string, connectionId: string): Promise<ConnectionRecord | null>;
  list(brandId: string): Promise<ConnectionRecord[]>;
  put(connection: ConnectionRecord): Promise<void>;
}

export type RetailImportStatus = 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface RetailImportCounts {
  rowsProcessed: number;
  rowsValid: number;
  rowsInvalid: number;
  mappingsCreated: number;
  mappingsFailed: number;
}

/** docs/04_DATA_MODEL.md §10.1 */
export interface RetailImportRecord extends RetailImportCounts {
  importId: string;
  brandId: string;
  fileKey: string;
  fileName: string;
  uploadedBy: string;
  status: RetailImportStatus;
  /** File-level failure (e.g. MISSING_COLUMNS), or null. */
  failureCode: string | null;
  rowErrorsReference: string | null;
  /** ISO-8601 */
  createdAt: string | null;
  completedAt: string | null;
}

export interface RetailImportRepository {
  create(record: RetailImportRecord): Promise<void>;
  get(brandId: string, importId: string): Promise<RetailImportRecord | null>;
  /** Newest first. */
  list(brandId: string, limit: number): Promise<RetailImportRecord[]>;
  /** UPLOADED → PROCESSING atomically; false if the import is in any other state. */
  claimForProcessing(brandId: string, importId: string): Promise<boolean>;
  finish(
    brandId: string,
    importId: string,
    result: RetailImportCounts & {
      status: 'COMPLETED' | 'FAILED';
      failureCode: string | null;
      rowErrorsReference: string | null;
    },
  ): Promise<void>;
}

/** docs/04_DATA_MODEL.md §18 */
export interface BrandAuditInput {
  brandId: string;
  actorType: 'PLATFORM_ADMIN' | 'USER' | 'SYSTEM' | 'AGENT' | 'CUSTOMER';
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  reasonCode: string | null;
}

/** docs/04_DATA_MODEL.md §18.0 */
export interface PlatformAuditInput {
  actorId: string;
  action: string;
  targetBrandId: string | null;
  targetType: string;
  targetId: string;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  reasonCode: string | null;
}

export interface PlatformAuditRecord extends PlatformAuditInput {
  auditId: string;
  timestamp: string | null;
}

export interface AuditRepository {
  /**
   * Writes a PlatformAuditEvent and — when it concerns a brand — the mirrored
   * AuditEvent (actor_type PLATFORM_ADMIN) in that brand, atomically.
   */
  recordPlatformEvent(event: PlatformAuditInput): Promise<void>;
  recordBrandEvent(event: BrandAuditInput): Promise<void>;
  listPlatformEvents(limit: number): Promise<PlatformAuditRecord[]>;
}

export class MalformedDocumentError extends Error {
  constructor(readonly path: string) {
    super(`Malformed Firestore document: ${path}`);
    this.name = 'MalformedDocumentError';
  }
}

/** A business-rule conflict detected inside a transaction, identified by a code. */
export class DomainConflictError extends Error {
  constructor(readonly code: string) {
    super(`Conflict: ${code}`);
    this.name = 'DomainConflictError';
  }
}

export class ConflictError extends Error {
  constructor(readonly path: string) {
    super(`Document already exists: ${path}`);
    this.name = 'ConflictError';
  }
}
