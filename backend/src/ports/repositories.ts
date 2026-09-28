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
  /** The store's single RETAIL_ADMIN (at most one per store), or null before provisioning. */
  retailAdminUserId: string | null;
}

export interface StoreRepository {
  get(brandId: string, storeId: string): Promise<StoreRecord | null>;
  list(brandId: string): Promise<StoreRecord[]>;
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

/** docs/04_DATA_MODEL.md §18 */
export interface BrandAuditInput {
  brandId: string;
  actorType: 'PLATFORM_ADMIN' | 'USER' | 'SYSTEM' | 'AGENT';
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
