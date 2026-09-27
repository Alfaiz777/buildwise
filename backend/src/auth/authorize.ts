import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, Errors } from '../lib/errors.js';
import { isRetailRole, type Principal, type Role } from './types.js';

/** The authenticated principal. Only valid on routes mounted after authenticate(). */
export function getPrincipal(res: Response): Principal {
  const principal = res.locals.principal;
  if (!principal) throw new AppError(500, 'INTERNAL', 'Something went wrong.');
  return principal;
}

/** Step 3 of the auth chain: route authorization by role → 403. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(getPrincipal(res).role)) throw Errors.forbidden();
    next();
  };
}

/**
 * Step 4 of the auth chain: resource authorization.
 * Another tenant's resource, or a store outside a retail user's store_ids,
 * yields 404 so its existence is not revealed.
 */
export function assertTenantAccess(principal: Principal, resource: { brandId: string; storeId?: string }): void {
  if (resource.brandId !== principal.brandId) throw Errors.notFound();
  if (isRetailRole(principal.role)) {
    if (!resource.storeId || !principal.storeIds.includes(resource.storeId)) throw Errors.notFound();
  }
}
