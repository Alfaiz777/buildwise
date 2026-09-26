export const ROLES = [
  'BRAND_ADMIN',
  'BRAND_MARKETING',
  'BRAND_OPERATIONS',
  'RETAIL_MANAGER',
  'RETAIL_STAFF',
] as const;

export type Role = (typeof ROLES)[number];

export const BRAND_ROLES: readonly Role[] = ['BRAND_ADMIN', 'BRAND_MARKETING', 'BRAND_OPERATIONS'];
export const RETAIL_ROLES: readonly Role[] = ['RETAIL_MANAGER', 'RETAIL_STAFF'];

export function isRetailRole(role: Role): boolean {
  return RETAIL_ROLES.includes(role);
}

/**
 * The verified caller. Built only by the authenticate middleware from a verified
 * Firebase ID token plus the users/{uid} document — never from request input.
 */
export interface Principal {
  readonly userId: string;
  readonly email: string | null;
  readonly brandId: string;
  readonly role: Role;
  /** Stores a RETAIL_* user may access. Empty for BRAND_* roles. */
  readonly storeIds: readonly string[];
}
