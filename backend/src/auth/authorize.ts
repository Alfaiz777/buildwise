import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { canAccessTenantResource, type TenantResource } from '../domain/access.js';
import type {
  BrandPrincipal,
  PlatformPrincipal,
  Principal,
  RetailPrincipal,
  Scope,
  TenantPrincipal,
} from '../domain/principal.js';
import { AppError, Errors } from '../lib/errors.js';

/** The authenticated principal. Only valid on routes mounted after authenticate(). */
export function getPrincipal(res: Response): Principal {
  const principal = res.locals.principal;
  if (!principal) throw new AppError(500, 'INTERNAL', 'Something went wrong.');
  return principal;
}

/** For routes mounted behind requireScope('BRAND', 'RETAIL'). */
export function getTenantPrincipal(res: Response): TenantPrincipal {
  const principal = getPrincipal(res);
  if (principal.scope === 'PLATFORM') throw Errors.forbidden();
  return principal;
}

/** For routes mounted behind requireScope('PLATFORM'). */
export function getPlatformPrincipal(res: Response): PlatformPrincipal {
  const principal = getPrincipal(res);
  if (principal.scope !== 'PLATFORM') throw Errors.forbidden();
  return principal;
}

/** For routes mounted behind requireScope('BRAND'). */
export function getBrandPrincipal(res: Response): BrandPrincipal {
  const principal = getPrincipal(res);
  if (principal.scope !== 'BRAND') throw Errors.forbidden();
  return principal;
}

/** For routes mounted behind requireScope('RETAIL'). */
export function getRetailPrincipal(res: Response): RetailPrincipal {
  const principal = getPrincipal(res);
  if (principal.scope !== 'RETAIL') throw Errors.forbidden();
  return principal;
}

/**
 * Step 3: route authorization → 403. Each scope has exactly one role
 * (PLATFORM_ADMIN, BRAND_ADMIN, RETAIL_ADMIN), so scope is the whole route check.
 * PLATFORM is refused on every tenant route.
 */
export function requireScope(...scopes: Scope[]): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!scopes.includes(getPrincipal(res).scope)) throw Errors.forbidden();
    next();
  };
}

/**
 * Step 4: resource authorization. Anything outside the principal's scope yields
 * 404 so its existence is not revealed (docs/07_SECURITY_SPEC.md §4.1).
 */
export function assertTenantAccess(principal: Principal, resource: TenantResource): void {
  if (!canAccessTenantResource(principal, resource)) throw Errors.notFound();
}
