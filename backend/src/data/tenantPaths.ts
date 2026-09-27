import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { Principal } from '../auth/types.js';

/** Tenant-scoped collections under brands/{brand_id}/ (docs/04_DATA_MODEL.md §21). */
export const TENANT_COLLECTIONS = [
  'connections',
  'customers',
  'products',
  'productVariants',
  'productMappings',
  'stores',
  'retailInventory',
  'customerIntents',
  'conversations',
  'aiRecommendations',
  'reservations',
  'outcomes',
  'commerceEvents',
  'auditEvents',
] as const;

export type TenantCollection = (typeof TENANT_COLLECTIONS)[number];

/**
 * The only way application code should reach tenant data. These helpers take a
 * verified Principal, not a brand ID string, so a client-supplied brand_id
 * cannot select the tenant.
 */
export function brandDoc(db: Firestore, principal: Principal): DocumentReference {
  return db.collection('brands').doc(principal.brandId);
}

export function tenantCollection(db: Firestore, principal: Principal, name: TenantCollection): CollectionReference {
  return brandDoc(db, principal).collection(name);
}
