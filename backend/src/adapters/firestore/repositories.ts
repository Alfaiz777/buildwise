import { FieldValue, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import type { StoreAssignmentDecision, StoreAssignmentState } from '../../domain/retailOwnership.js';
import {
  ConflictError,
  DomainConflictError,
  MalformedDocumentError,
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
} from '../../ports/repositories.js';

/**
 * Firestore implementations of the repository ports. The same code runs against
 * the Firestore emulator (local profile) and Firestore (gcp profile).
 * Paths follow docs/04_DATA_MODEL.md §21. Unknown extra fields are ignored.
 */

const isoOrNull = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null);

/** gRPC ALREADY_EXISTS */
const isAlreadyExists = (err: unknown) => (err as { code?: unknown }).code === 6;

function parse<T>(schema: z.ZodType<T>, data: unknown, path: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new MalformedDocumentError(path);
  return parsed.data;
}

/**
 * One-admin slot stored in `field` of the scope document (brand or store).
 * `requires` names a field that must already be set (e.g. the store's retailer).
 */
function adminSlot(
  db: Firestore,
  ref: DocumentReference,
  field: string,
  requires?: { field: string; code: string },
): AdminSlot {
  return {
    async claimAdmin(userId) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new MalformedDocumentError(ref.path);
        if (requires && !snap.get(requires.field)) throw new DomainConflictError(requires.code);
        const holder = snap.get(field) as string | null | undefined;
        if (holder && holder !== userId) throw new ConflictError(`${ref.path}#${field}`);
        tx.update(ref, { [field]: userId, updated_at: FieldValue.serverTimestamp() });
      });
    },
    async releaseAdmin(userId) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.get(field) === userId) {
          tx.update(ref, { [field]: null, updated_at: FieldValue.serverTimestamp() });
        }
      });
    },
  };
}

const UserDoc = z.object({
  role: z.string().min(1),
  brand_id: z.string().min(1).nullable().optional(),
  retailer_id: z.string().min(1).nullable().optional(),
  store_id: z.string().min(1).nullable().optional(),
  email: z.string().nullable().optional(),
  status: z.string().min(1),
});

const toUser = (userId: string, d: z.infer<typeof UserDoc>): UserRecord => ({
  userId,
  role: d.role,
  brandId: d.brand_id ?? null,
  retailerId: d.retailer_id ?? null,
  storeId: d.store_id ?? null,
  email: d.email ?? null,
  status: d.status,
});

export class FirestoreUserRepository implements UserRepository {
  constructor(private readonly db: Firestore) {}

  async getById(userId: string): Promise<UserRecord | null> {
    const ref = this.db.collection('users').doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    return toUser(userId, parse(UserDoc, snap.data(), ref.path));
  }

  async create(user: NewUser): Promise<void> {
    const ref = this.db.collection('users').doc(user.userId);
    try {
      await ref.create({
        user_id: user.userId,
        role: user.role,
        brand_id: user.brandId,
        retailer_id: user.retailerId,
        store_id: user.storeId,
        email: user.email,
        status: 'ACTIVE',
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (isAlreadyExists(err)) throw new ConflictError(ref.path);
      throw err;
    }
  }

  async listByBrand(brandId: string): Promise<UserRecord[]> {
    const snap = await this.db.collection('users').where('brand_id', '==', brandId).get();
    return snap.docs.map((doc) => toUser(doc.id, parse(UserDoc, doc.data(), doc.ref.path)));
  }
}

const BrandDoc = z.object({
  name: z.string(),
  status: z.string().min(1),
  created_at: z.unknown().optional(),
  brand_admin_user_id: z.string().min(1).nullable().optional(),
});

const toBrand = (brandId: string, d: z.infer<typeof BrandDoc>): BrandRecord => ({
  brandId,
  name: d.name,
  status: d.status,
  createdAt: isoOrNull(d.created_at),
  brandAdminUserId: d.brand_admin_user_id ?? null,
});

export class FirestoreBrandRepository implements BrandRepository {
  constructor(private readonly db: Firestore) {}

  async getById(brandId: string): Promise<BrandRecord | null> {
    const ref = this.db.collection('brands').doc(brandId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    return toBrand(brandId, parse(BrandDoc, snap.data(), ref.path));
  }

  async list(): Promise<BrandRecord[]> {
    const snap = await this.db.collection('brands').limit(500).get();
    return snap.docs
      .map((doc) => toBrand(doc.id, parse(BrandDoc, doc.data(), doc.ref.path)))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  async create(brand: { brandId: string; name: string }): Promise<BrandRecord> {
    const ref = this.db.collection('brands').doc(brand.brandId);
    try {
      await ref.create({
        brand_id: brand.brandId,
        name: brand.name,
        status: 'ACTIVE',
        settings: {},
        brand_admin_user_id: null,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (isAlreadyExists(err)) throw new ConflictError(ref.path);
      throw err;
    }
    return (await this.getById(brand.brandId))!;
  }

  async setStatus(brandId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    await this.db.collection('brands').doc(brandId).update({ status, updated_at: FieldValue.serverTimestamp() });
  }

  adminSlot(brandId: string): AdminSlot {
    return adminSlot(this.db, this.db.collection('brands').doc(brandId), 'brand_admin_user_id');
  }
}

const RetailerDoc = z.object({
  name: z.string(),
  status: z.string().min(1),
});

const toRetailer = (retailerId: string, brandId: string, d: z.infer<typeof RetailerDoc>): RetailerRecord => ({
  retailerId,
  brandId,
  name: d.name,
  status: d.status,
});

export class FirestoreRetailerRepository implements RetailerRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('retailers');
  }

  async get(brandId: string, retailerId: string): Promise<RetailerRecord | null> {
    const ref = this.col(brandId).doc(retailerId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    return toRetailer(retailerId, brandId, parse(RetailerDoc, snap.data(), ref.path));
  }

  async list(brandId: string): Promise<RetailerRecord[]> {
    const snap = await this.col(brandId).get();
    return snap.docs.map((doc) => toRetailer(doc.id, brandId, parse(RetailerDoc, doc.data(), doc.ref.path)));
  }

  async create(retailer: { brandId: string; retailerId: string; name: string }): Promise<RetailerRecord> {
    const ref = this.col(retailer.brandId).doc(retailer.retailerId);
    try {
      await ref.create({
        retailer_id: retailer.retailerId,
        brand_id: retailer.brandId,
        name: retailer.name,
        status: 'ACTIVE',
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (isAlreadyExists(err)) throw new ConflictError(ref.path);
      throw err;
    }
    return {
      retailerId: retailer.retailerId,
      brandId: retailer.brandId,
      name: retailer.name,
      status: 'ACTIVE',
    };
  }
}

const StoreDoc = z.object({
  store_name: z.string(),
  city: z.string().default(''),
  address: z.string().nullable().optional(),
  store_status: z.string().min(1),
  store_hours: z.record(z.string(), z.string()).nullable().optional(),
  retailer_id: z.string().min(1).nullable().optional(),
  retail_admin_user_id: z.string().min(1).nullable().optional(),
});

const toStore = (storeId: string, brandId: string, d: z.infer<typeof StoreDoc>): StoreRecord => ({
  storeId,
  brandId,
  retailerId: d.retailer_id ?? null,
  storeName: d.store_name,
  city: d.city,
  address: d.address ?? null,
  storeStatus: d.store_status,
  storeHours: d.store_hours ?? null,
  retailAdminUserId: d.retail_admin_user_id ?? null,
});

export class FirestoreStoreRepository implements StoreRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('stores');
  }

  async get(brandId: string, storeId: string): Promise<StoreRecord | null> {
    const ref = this.col(brandId).doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    return toStore(storeId, brandId, parse(StoreDoc, snap.data(), ref.path));
  }

  async list(brandId: string): Promise<StoreRecord[]> {
    const snap = await this.col(brandId).limit(500).get();
    return snap.docs.map((doc) => toStore(doc.id, brandId, parse(StoreDoc, doc.data(), doc.ref.path)));
  }

  adminSlot(brandId: string, storeId: string): AdminSlot {
    return adminSlot(this.db, this.col(brandId).doc(storeId), 'retail_admin_user_id', {
      field: 'retailer_id',
      code: 'STORE_HAS_NO_RETAILER',
    });
  }

  async assignRetailer(
    brandId: string,
    storeId: string,
    retailerId: string | null,
    decide: (state: StoreAssignmentState) => StoreAssignmentDecision,
  ): Promise<StoreAssignmentDecision> {
    const retailers = this.db.collection('brands').doc(brandId).collection('retailers');
    const storeRef = this.col(brandId).doc(storeId);
    return this.db.runTransaction(async (tx) => {
      const storeSnap = await tx.get(storeRef);
      const targetSnap = retailerId ? await tx.get(retailers.doc(retailerId)) : null;

      const decision = decide({
        store: storeSnap.exists
          ? {
              storeId,
              retailerId: (storeSnap.get('retailer_id') as string | null) ?? null,
              retailAdminUserId: (storeSnap.get('retail_admin_user_id') as string | null) ?? null,
            }
          : null,
        target: retailerId === null ? null : targetSnap?.exists ? { retailerId } : undefined,
      });
      if (!decision.ok || decision.change === 'NONE') return decision;

      tx.update(storeRef, {
        retailer_id: decision.change === 'ASSIGN' ? retailerId : null,
        updated_at: FieldValue.serverTimestamp(),
      });
      return decision;
    });
  }
}

const PlatformAuditDoc = z.object({
  actor_id: z.string(),
  action: z.string(),
  target_brand_id: z.string().nullable(),
  target_type: z.string(),
  target_id: z.string(),
  result: z.enum(['SUCCESS', 'DENIED', 'FAILED']),
  reason_code: z.string().nullable(),
  timestamp: z.unknown().optional(),
});

export class FirestoreAuditRepository implements AuditRepository {
  constructor(private readonly db: Firestore) {}

  private brandAuditDoc(event: BrandAuditInput) {
    const ref = this.db.collection('brands').doc(event.brandId).collection('auditEvents').doc();
    return {
      ref,
      data: {
        audit_id: ref.id,
        brand_id: event.brandId,
        actor_type: event.actorType,
        actor_id: event.actorId,
        action: event.action,
        target_type: event.targetType,
        target_id: event.targetId,
        result: event.result,
        reason_code: event.reasonCode,
        timestamp: FieldValue.serverTimestamp(),
      },
    };
  }

  async recordPlatformEvent(event: PlatformAuditInput): Promise<void> {
    const batch = this.db.batch();
    const ref = this.db.collection('platformAuditEvents').doc();
    batch.create(ref, {
      audit_id: ref.id,
      actor_id: event.actorId,
      action: event.action,
      target_brand_id: event.targetBrandId,
      target_type: event.targetType,
      target_id: event.targetId,
      result: event.result,
      reason_code: event.reasonCode,
      timestamp: FieldValue.serverTimestamp(),
    });
    if (event.targetBrandId) {
      const mirror = this.brandAuditDoc({
        brandId: event.targetBrandId,
        actorType: 'PLATFORM_ADMIN',
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        result: event.result,
        reasonCode: event.reasonCode,
      });
      batch.create(mirror.ref, mirror.data);
    }
    await batch.commit();
  }

  async recordBrandEvent(event: BrandAuditInput): Promise<void> {
    const { ref, data } = this.brandAuditDoc(event);
    await ref.create(data);
  }

  async listPlatformEvents(limit: number): Promise<PlatformAuditRecord[]> {
    const snap = await this.db.collection('platformAuditEvents').orderBy('timestamp', 'desc').limit(limit).get();
    return snap.docs.map((doc) => {
      const d = parse(PlatformAuditDoc, doc.data(), doc.ref.path);
      return {
        auditId: doc.id,
        actorId: d.actor_id,
        action: d.action,
        targetBrandId: d.target_brand_id,
        targetType: d.target_type,
        targetId: d.target_id,
        result: d.result,
        reasonCode: d.reason_code,
        timestamp: isoOrNull(d.timestamp),
      };
    });
  }
}
