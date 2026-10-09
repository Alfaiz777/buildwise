import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type WriteBatch,
} from 'firebase-admin/firestore';
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
} from '../../ports/repositories.js';

/**
 * Firestore implementations of the repository ports. The same code runs against
 * the Firestore emulator (local profile) and Firestore (gcp profile).
 * Paths follow docs/04_DATA_MODEL.md §21. Unknown extra fields are ignored.
 */

const isoOrNull = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null);

/** gRPC ALREADY_EXISTS */
const isAlreadyExists = (err: unknown) => (err as { code?: unknown }).code === 6;

/** Firestore allows 500 writes per batch; stay well below. */
const BATCH_LIMIT = 450;

async function commitInChunks(db: Firestore, writes: ((batch: WriteBatch) => void)[]): Promise<void> {
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + BATCH_LIMIT)) write(batch);
    await batch.commit();
  }
}

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
  settings: z.record(z.string(), z.unknown()).nullable().optional(),
});

const toBrand = (brandId: string, d: z.infer<typeof BrandDoc>): BrandRecord => ({
  brandId,
  name: d.name,
  status: d.status,
  createdAt: isoOrNull(d.created_at),
  brandAdminUserId: d.brand_admin_user_id ?? null,
  settings: d.settings ?? {},
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
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  reservation_available: z.boolean().optional(),
  pickup_available: z.boolean().optional(),
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
  latitude: d.latitude ?? null,
  longitude: d.longitude ?? null,
  reservationAvailable: d.reservation_available ?? true,
  pickupAvailable: d.pickup_available ?? true,
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

  async upsertFromImport(brandId: string, stores: StoreImportFields[]): Promise<void> {
    if (stores.length === 0) return;
    const refs = stores.map((s) => this.col(brandId).doc(s.storeId));
    const existing = new Set((await this.db.getAll(...refs)).filter((snap) => snap.exists).map((snap) => snap.id));
    const now = FieldValue.serverTimestamp();
    await commitInChunks(
      this.db,
      stores.map((s, i) => (batch: WriteBatch) => {
        const fields = {
          store_id: s.storeId,
          brand_id: brandId,
          store_name: s.storeName,
          city: s.city,
          address: s.address,
          latitude: s.latitude,
          longitude: s.longitude,
          store_hours: s.storeHours,
          store_status: s.storeStatus,
          reservation_available: s.reservationAvailable,
          pickup_available: s.pickupAvailable,
          updated_at: now,
        };
        // Ownership and admin fields are only initialized on create, never overwritten.
        if (existing.has(s.storeId)) batch.set(refs[i]!, fields, { merge: true });
        else batch.create(refs[i]!, { ...fields, retailer_id: null, retail_admin_user_id: null });
      }),
    );
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

  async latestBrandEventAt(brandId: string): Promise<string | null> {
    const snap = await this.db
      .collection(`brands/${brandId}/auditEvents`)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .select('timestamp')
      .get();
    return snap.empty ? null : isoOrNull(snap.docs[0]!.get('timestamp'));
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

// ---------------------------------------------------------------------------
// Catalogue (docs/04_DATA_MODEL.md §7–§8.1)

const ProductDoc = z.object({
  canonical_product_id: z.string(),
  shopify_product_id: z.string(),
  title: z.string(),
  description: z.string().default(''),
  category: z.string().nullable().optional(),
  status: z.string(),
  tags: z.array(z.string()).default([]),
  attributes: z.record(z.string(), z.string()).default({}),
  image_url: z.string().nullable().optional(),
  handle: z.string().nullable().optional(),
});

const VariantDoc = z.object({
  product_id: z.string(),
  shopify_variant_id: z.string(),
  title: z.string(),
  sku: z.string(),
  canonical_sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  price: z.number(),
  currency: z.string(),
  status: z.string(),
});

export class FirestoreProductRepository implements ProductRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string, name: 'products' | 'productVariants') {
    return this.db.collection('brands').doc(brandId).collection(name);
  }

  async listProducts(brandId: string): Promise<ProductRecord[]> {
    const snap = await this.col(brandId, 'products').get();
    return snap.docs.map((doc) => {
      const d = parse(ProductDoc, doc.data(), doc.ref.path);
      return {
        productId: doc.id,
        brandId,
        canonicalProductId: d.canonical_product_id,
        shopifyProductId: d.shopify_product_id,
        title: d.title,
        description: d.description,
        category: d.category ?? null,
        status: d.status,
        tags: d.tags,
        attributes: d.attributes,
        imageUrl: d.image_url ?? null,
        handle: d.handle ?? null,
      };
    });
  }

  async listVariants(brandId: string): Promise<VariantRecord[]> {
    const snap = await this.col(brandId, 'productVariants').get();
    return snap.docs.map((doc) => {
      const d = parse(VariantDoc, doc.data(), doc.ref.path);
      return {
        variantId: doc.id,
        brandId,
        productId: d.product_id,
        shopifyVariantId: d.shopify_variant_id,
        title: d.title,
        sku: d.sku,
        canonicalSku: d.canonical_sku ?? null,
        barcode: d.barcode ?? null,
        price: d.price,
        currency: d.currency,
        status: d.status,
      };
    });
  }

  async upsertCatalog(brandId: string, products: ProductRecord[], variants: VariantRecord[]): Promise<void> {
    const now = FieldValue.serverTimestamp();
    await commitInChunks(this.db, [
      ...products.map(
        (p) => (batch: WriteBatch) =>
          batch.set(this.col(brandId, 'products').doc(p.productId), {
            product_id: p.productId,
            brand_id: brandId,
            canonical_product_id: p.canonicalProductId,
            shopify_product_id: p.shopifyProductId,
            title: p.title,
            description: p.description,
            category: p.category,
            status: p.status,
            tags: p.tags,
            attributes: p.attributes,
            image_url: p.imageUrl ?? null,
            handle: p.handle ?? null,
            asset_references: [],
            updated_at: now,
          }),
      ),
      ...variants.map(
        (v) => (batch: WriteBatch) =>
          batch.set(this.col(brandId, 'productVariants').doc(v.variantId), {
            variant_id: v.variantId,
            brand_id: brandId,
            product_id: v.productId,
            shopify_variant_id: v.shopifyVariantId,
            title: v.title,
            sku: v.sku,
            canonical_sku: v.canonicalSku,
            barcode: v.barcode,
            price: v.price,
            currency: v.currency,
            status: v.status,
            updated_at: now,
          }),
      ),
    ]);
  }
}

const MappingDoc = z.object({
  source_system: z.enum(['SHOPIFY', 'RETAIL_FILE']),
  source_identifier: z.string(),
  canonical_sku: z.string().nullable().optional(),
  variant_id: z.string().nullable().optional(),
  mapping_status: z.enum(['AUTO_MATCHED', 'MANUAL_MATCH_REQUIRED', 'CONFLICT', 'UNMAPPED']),
  mapping_reason: z.string(),
  updated_at: z.unknown().optional(),
});

export class FirestoreMappingRepository implements MappingRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('productMappings');
  }

  async list(brandId: string): Promise<MappingRecord[]> {
    const snap = await this.col(brandId).get();
    return snap.docs.map((doc) => {
      const d = parse(MappingDoc, doc.data(), doc.ref.path);
      return {
        mappingId: doc.id,
        brandId,
        sourceSystem: d.source_system,
        sourceIdentifier: d.source_identifier,
        canonicalSku: d.canonical_sku ?? null,
        variantId: d.variant_id ?? null,
        mappingStatus: d.mapping_status,
        mappingReason: d.mapping_reason,
        updatedAt: isoOrNull(d.updated_at),
      };
    });
  }

  async upsertMany(brandId: string, mappings: MappingRecord[]): Promise<void> {
    const now = FieldValue.serverTimestamp();
    await commitInChunks(
      this.db,
      mappings.map(
        (m) => (batch: WriteBatch) =>
          batch.set(this.col(brandId).doc(m.mappingId), {
            mapping_id: m.mappingId,
            brand_id: brandId,
            source_system: m.sourceSystem,
            source_identifier: m.sourceIdentifier,
            canonical_sku: m.canonicalSku,
            variant_id: m.variantId,
            mapping_status: m.mappingStatus,
            mapping_reason: m.mappingReason,
            updated_at: now,
          }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Retail inventory (docs/04_DATA_MODEL.md §10)

const InventoryDoc = z.object({
  store_id: z.string(),
  sku: z.string(),
  canonical_sku: z.string(),
  variant_id: z.string(),
  quantity: z.number(),
  reserved_quantity: z.number().default(0),
  offline_price: z.number(),
  availability_status: z.string(),
  last_updated_at: z.unknown().optional(),
});

/** Deterministic: one document per store and canonical SKU (docs/04 §10). */
export const inventoryIdFor = (storeId: string, canonicalSku: string) => `${storeId}__${canonicalSku}`;

export class FirestoreInventoryRepository implements InventoryRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('retailInventory');
  }

  private toRecord(brandId: string, id: string, data: unknown, path: string): InventoryRecord {
    const d = parse(InventoryDoc, data, path);
    return {
      inventoryId: id,
      brandId,
      storeId: d.store_id,
      sku: d.sku,
      canonicalSku: d.canonical_sku,
      variantId: d.variant_id,
      quantity: d.quantity,
      reservedQuantity: d.reserved_quantity,
      offlinePrice: d.offline_price,
      availabilityStatus: d.availability_status,
      lastUpdatedAt: isoOrNull(d.last_updated_at),
    };
  }

  private async query(brandId: string, field?: string, value?: string): Promise<InventoryRecord[]> {
    const col = this.col(brandId);
    const snap = await (field ? col.where(field, '==', value) : col).get();
    return snap.docs.map((doc) => this.toRecord(brandId, doc.id, doc.data(), doc.ref.path));
  }

  listByBrand(brandId: string) {
    return this.query(brandId);
  }

  listByStore(brandId: string, storeId: string) {
    return this.query(brandId, 'store_id', storeId);
  }

  listByVariant(brandId: string, variantId: string) {
    return this.query(brandId, 'variant_id', variantId);
  }

  async upsertStock(
    brandId: string,
    rows: InventoryUpsert[],
    availabilityOf: (quantity: number, reservedQuantity: number) => string,
  ): Promise<void> {
    if (rows.length === 0) return;
    const refs = rows.map((r) => this.col(brandId).doc(inventoryIdFor(r.storeId, r.canonicalSku)));
    const now = FieldValue.serverTimestamp();
    const writes: ((batch: WriteBatch) => void)[] = [];
    for (let i = 0; i < rows.length; i += 100) {
      const snaps = await this.db.getAll(...refs.slice(i, i + 100));
      snaps.forEach((snap, j) => {
        const row = rows[i + j]!;
        // reserved_quantity is owned by the reservation transaction: read, never overwritten.
        const reserved = snap.exists ? Number(snap.get('reserved_quantity') ?? 0) : 0;
        const fields = {
          inventory_id: snap.id,
          brand_id: brandId,
          store_id: row.storeId,
          sku: row.sku,
          canonical_sku: row.canonicalSku,
          variant_id: row.variantId,
          quantity: row.quantity,
          offline_price: row.offlinePrice,
          availability_status: availabilityOf(row.quantity, reserved),
          last_updated_at: now,
        };
        writes.push((batch) =>
          snap.exists
            ? batch.set(snap.ref, fields, { merge: true })
            : batch.create(snap.ref, { ...fields, reserved_quantity: 0 }),
        );
      });
    }
    await commitInChunks(this.db, writes);
  }
}

// ---------------------------------------------------------------------------
// Integration connections (docs/04_DATA_MODEL.md §5) — never credentials

const ConnectionDoc = z.object({
  provider: z.enum(['SHOPIFY', 'WHATSAPP', 'RETAIL_FILE']),
  source: z.string().default(''),
  status: z.enum(['CONNECTED', 'ERROR', 'DISCONNECTED']),
  shop_domain: z.string().nullable().optional(),
  shop_name: z.string().nullable().optional(),
  connected_at: z.string().nullable().optional(),
  last_sync_at: z.string().nullable().optional(),
  last_error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  product_count: z.number().default(0),
  variant_count: z.number().default(0),
});

export class FirestoreConnectionRepository implements ConnectionRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('connections');
  }

  private toRecord(brandId: string, id: string, data: unknown, path: string): ConnectionRecord {
    const d = parse(ConnectionDoc, data, path);
    return {
      connectionId: id,
      brandId,
      provider: d.provider,
      source: d.source,
      status: d.status,
      shopDomain: d.shop_domain ?? null,
      shopName: d.shop_name ?? null,
      connectedAt: d.connected_at ?? null,
      lastSyncAt: d.last_sync_at ?? null,
      lastError: d.last_error ?? null,
      productCount: d.product_count,
      variantCount: d.variant_count,
    };
  }

  async get(brandId: string, connectionId: string): Promise<ConnectionRecord | null> {
    const ref = this.col(brandId).doc(connectionId);
    const snap = await ref.get();
    return snap.exists ? this.toRecord(brandId, snap.id, snap.data(), ref.path) : null;
  }

  async list(brandId: string): Promise<ConnectionRecord[]> {
    const snap = await this.col(brandId).get();
    return snap.docs.map((doc) => this.toRecord(brandId, doc.id, doc.data(), doc.ref.path));
  }

  async put(c: ConnectionRecord): Promise<void> {
    await this.col(c.brandId)
      .doc(c.connectionId)
      .set({
        connection_id: c.connectionId,
        brand_id: c.brandId,
        provider: c.provider,
        source: c.source,
        status: c.status,
        shop_domain: c.shopDomain ?? null,
        shop_name: c.shopName ?? null,
        external_account_id: null,
        credential_reference: null,
        connected_at: c.connectedAt,
        last_sync_at: c.lastSyncAt,
        last_error: c.lastError,
        product_count: c.productCount,
        variant_count: c.variantCount,
        updated_at: FieldValue.serverTimestamp(),
      });
  }
}

// ---------------------------------------------------------------------------
// Retail imports (docs/04_DATA_MODEL.md §10.1)

const RetailImportDoc = z.object({
  file_key: z.string(),
  file_name: z.string(),
  uploaded_by: z.string(),
  status: z.enum(['UPLOADED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  failure_code: z.string().nullable().optional(),
  row_errors_reference: z.string().nullable().optional(),
  rows_processed: z.number().default(0),
  rows_valid: z.number().default(0),
  rows_invalid: z.number().default(0),
  mappings_created: z.number().default(0),
  mappings_failed: z.number().default(0),
  created_at: z.unknown().optional(),
  completed_at: z.unknown().optional(),
});

export class FirestoreRetailImportRepository implements RetailImportRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('retailImports');
  }

  private toRecord(brandId: string, id: string, data: unknown, path: string): RetailImportRecord {
    const d = parse(RetailImportDoc, data, path);
    return {
      importId: id,
      brandId,
      fileKey: d.file_key,
      fileName: d.file_name,
      uploadedBy: d.uploaded_by,
      status: d.status,
      failureCode: d.failure_code ?? null,
      rowErrorsReference: d.row_errors_reference ?? null,
      rowsProcessed: d.rows_processed,
      rowsValid: d.rows_valid,
      rowsInvalid: d.rows_invalid,
      mappingsCreated: d.mappings_created,
      mappingsFailed: d.mappings_failed,
      createdAt: isoOrNull(d.created_at),
      completedAt: isoOrNull(d.completed_at),
    };
  }

  async create(r: RetailImportRecord): Promise<void> {
    await this.col(r.brandId).doc(r.importId).create({
      import_id: r.importId,
      brand_id: r.brandId,
      file_key: r.fileKey,
      file_name: r.fileName,
      uploaded_by: r.uploadedBy,
      status: r.status,
      failure_code: null,
      row_errors_reference: null,
      rows_processed: 0,
      rows_valid: 0,
      rows_invalid: 0,
      mappings_created: 0,
      mappings_failed: 0,
      created_at: FieldValue.serverTimestamp(),
      completed_at: null,
    });
  }

  async get(brandId: string, importId: string): Promise<RetailImportRecord | null> {
    const ref = this.col(brandId).doc(importId);
    const snap = await ref.get();
    return snap.exists ? this.toRecord(brandId, snap.id, snap.data(), ref.path) : null;
  }

  async list(brandId: string, limit: number): Promise<RetailImportRecord[]> {
    const snap = await this.col(brandId).orderBy('created_at', 'desc').limit(limit).get();
    return snap.docs.map((doc) => this.toRecord(brandId, doc.id, doc.data(), doc.ref.path));
  }

  async claimForProcessing(brandId: string, importId: string): Promise<boolean> {
    const ref = this.col(brandId).doc(importId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('status') !== 'UPLOADED') return false;
      tx.update(ref, { status: 'PROCESSING' });
      return true;
    });
  }

  async finish(
    brandId: string,
    importId: string,
    r: RetailImportCounts & {
      status: 'COMPLETED' | 'FAILED';
      failureCode: string | null;
      rowErrorsReference: string | null;
    },
  ): Promise<void> {
    await this.col(brandId).doc(importId).update({
      status: r.status,
      failure_code: r.failureCode,
      row_errors_reference: r.rowErrorsReference,
      rows_processed: r.rowsProcessed,
      rows_valid: r.rowsValid,
      rows_invalid: r.rowsInvalid,
      mappings_created: r.mappingsCreated,
      mappings_failed: r.mappingsFailed,
      completed_at: FieldValue.serverTimestamp(),
    });
  }
}
