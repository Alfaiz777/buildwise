import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { MalformedDocumentError } from './errors.js';
import type { BrandRecord, BrandRepository, UserRecord, UserRepository } from './types.js';

/** Stored document shapes (docs/04_DATA_MODEL.md §3, §4). Unknown extra fields are ignored. */
const UserDoc = z.object({
  brand_id: z.string().min(1),
  role: z.string().min(1),
  store_ids: z.array(z.string().min(1)).default([]),
  email: z.string().nullable().optional(),
  status: z.string().min(1),
});

const BrandDoc = z.object({
  name: z.string(),
  status: z.string().min(1),
});

export class FirestoreUserRepository implements UserRepository {
  constructor(private readonly db: Firestore) {}

  async getById(userId: string): Promise<UserRecord | null> {
    const ref = this.db.collection('users').doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const parsed = UserDoc.safeParse(snap.data());
    if (!parsed.success) throw new MalformedDocumentError(ref.path);
    const d = parsed.data;
    return {
      userId,
      brandId: d.brand_id,
      role: d.role,
      storeIds: d.store_ids,
      email: d.email ?? null,
      status: d.status,
    };
  }
}

export class FirestoreBrandRepository implements BrandRepository {
  constructor(private readonly db: Firestore) {}

  async getById(brandId: string): Promise<BrandRecord | null> {
    const ref = this.db.collection('brands').doc(brandId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const parsed = BrandDoc.safeParse(snap.data());
    if (!parsed.success) throw new MalformedDocumentError(ref.path);
    return { brandId, name: parsed.data.name, status: parsed.data.status };
  }
}
