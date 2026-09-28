import type { CollectionReference, DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { TenantPrincipal } from '../domain/principal.js';

/** Tenant-scoped collections under brands/{brand_id}/ (docs/04_DATA_MODEL.md §21). */
export const TENANT_COLLECTIONS = [
  'connections',
  'customers',
  'products',
  'productVariants',
  'productMappings',
  'retailers',
  'stores',
  'retailInventory',
  'retailImports',
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
 * Tenant data paths built from a verified TenantPrincipal — never from a brand
 * ID string — so a client-supplied brand_id cannot select the tenant. Platform
 * principals cannot be passed here (type error): platform code reaches brand
 * data only through explicit, audited platform services.
 */
export function brandDoc(db: Firestore, principal: TenantPrincipal): DocumentReference {
  return db.collection('brands').doc(principal.brandId);
}

export function tenantCollection(
  db: Firestore,
  principal: TenantPrincipal,
  name: TenantCollection,
): CollectionReference {
  return brandDoc(db, principal).collection(name);
}
