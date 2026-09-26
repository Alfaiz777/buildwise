/**
 * Stored shapes as read by the backend. Firestore documents use the snake_case
 * field names from docs/04_DATA_MODEL.md; repositories map them to these types.
 */

export interface UserRecord {
  userId: string;
  brandId: string;
  /** Raw stored value; validated against ROLES during principal resolution. */
  role: string;
  storeIds: string[];
  email: string | null;
  status: string;
}

export interface BrandRecord {
  brandId: string;
  name: string;
  status: string;
}

export interface UserRepository {
  /** users/{userId} — top-level: looked up before the brand is known. */
  getById(userId: string): Promise<UserRecord | null>;
}

export interface BrandRepository {
  /**
   * brands/{brandId}. Only call with a brand ID from a trusted source:
   * a resolved user document or an authenticated Principal.
   */
  getById(brandId: string): Promise<BrandRecord | null>;
}
