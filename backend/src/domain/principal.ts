/**
 * Roles, scopes and principals (docs/04_DATA_MODEL.md §4, docs/07_SECURITY_SPEC.md §4).
 *
 * The MVP has exactly three internal roles, one per console. The customer is not
 * a role: customers are resolved from their channel identity (CustomerPrincipal).
 *
 * A console principal is built only by the authenticate middleware from a verified
 * Firebase ID token plus the users/{uid} document — never from request input.
 * Platform scope is its own principal type; it is never a brand principal with
 * a wildcard brand ID.
 */

export const ROLES = ['PLATFORM_ADMIN', 'BRAND_ADMIN', 'RETAIL_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export type Scope = 'PLATFORM' | 'BRAND' | 'RETAIL';

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function scopeOf(role: Role): Scope {
  switch (role) {
    case 'PLATFORM_ADMIN':
      return 'PLATFORM';
    case 'BRAND_ADMIN':
      return 'BRAND';
    case 'RETAIL_ADMIN':
      return 'RETAIL';
  }
}

interface PrincipalBase {
  readonly userId: string;
  readonly email: string | null;
}

export interface PlatformPrincipal extends PrincipalBase {
  readonly scope: 'PLATFORM';
  readonly role: 'PLATFORM_ADMIN';
}

export interface BrandPrincipal extends PrincipalBase {
  readonly scope: 'BRAND';
  readonly role: 'BRAND_ADMIN';
  readonly brandId: string;
}

/**
 * Operates exactly ONE store of its retailer (a retailer may own many stores; each
 * store has at most one RETAIL_ADMIN). Never "all stores" of the retailer or brand.
 */
export interface RetailPrincipal extends PrincipalBase {
  readonly scope: 'RETAIL';
  readonly role: 'RETAIL_ADMIN';
  readonly brandId: string;
  readonly retailerId: string;
  readonly storeId: string;
}

/** A logged-in console user. */
export type Principal = PlatformPrincipal | BrandPrincipal | RetailPrincipal;

/** A principal that operates inside a brand tenant. Platform principals never are. */
export type TenantPrincipal = BrandPrincipal | RetailPrincipal;

/**
 * The customer is resolved, never logged in (docs/07_SECURITY_SPEC.md §4.3):
 * from a channel identity (WhatsApp / simulator) or a contextual page token.
 * Customer principals never reach console routes and never appear in users/{uid}.
 * Used from M4 onward.
 */
export interface CustomerPrincipal {
  readonly scope: 'CUSTOMER';
  readonly brandId: string;
  readonly customerId: string;
  readonly conversationId: string | null;
  readonly via: 'CHANNEL' | 'PAGE_TOKEN';
}

/** Brand IDs that could be mistaken for a wildcard are never valid tenants. */
const RESERVED_BRAND_IDS = new Set(['ALL', 'all', '*', 'ANY', 'any']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidTenantId(id: string): boolean {
  return ID_PATTERN.test(id) && !RESERVED_BRAND_IDS.has(id);
}
