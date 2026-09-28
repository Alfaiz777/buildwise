import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isRole, isValidTenantId, type Principal, type Role } from '../domain/principal.js';
import { isConsistentRetailOwnership } from '../domain/retailOwnership.js';
import { Errors } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import {
  MalformedDocumentError,
  type BrandRecord,
  type BrandRepository,
  type RetailerRecord,
  type RetailerRepository,
  type StoreRecord,
  type StoreRepository,
  type UserRecord,
  type UserRepository,
} from '../ports/repositories.js';
import type { TokenVerifier } from './tokenVerifier.js';

export interface AuthDeps {
  verifier: TokenVerifier;
  users: UserRepository;
  brands: BrandRepository;
  retailers: RetailerRepository;
  stores: StoreRepository;
  logger: Logger;
}

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      principal?: Principal;
      brand?: BrandRecord;
      retailer?: RetailerRecord;
      store?: StoreRecord;
    }
  }
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

/** The role → required-fields table (docs/04_DATA_MODEL.md §4). */
function hasValidShape(user: UserRecord, role: Role): boolean {
  const { brandId, retailerId, storeId } = user;
  const valid = (id: string | null): id is string => id !== null && isValidTenantId(id);
  switch (role) {
    case 'PLATFORM_ADMIN':
      return brandId === null && retailerId === null && storeId === null;
    case 'BRAND_ADMIN':
      return valid(brandId) && retailerId === null && storeId === null;
    case 'RETAIL_ADMIN':
      // Store-level scope: brand, retailer AND the one store are all mandatory.
      return valid(brandId) && valid(retailerId) && valid(storeId);
  }
}

/**
 * Steps 1–2 of the auth chain (docs/07_SECURITY_SPEC.md §4.1):
 *   1. verify the Firebase ID token                        → 401
 *   2. resolve a scoped principal from users/{uid}          → 403
 *      PLATFORM_ADMIN: no brand; BRAND_ADMIN: active brand whose admin of record it is;
 *      RETAIL_ADMIN: active brand + active retailer, and the STORE's admin of record,
 *        with user and store agreeing on the retailer (one store only).
 * Any other role value (including customer or retired roles) is rejected.
 * Nothing in the request body, query or path influences the principal.
 */
export function authenticate({ verifier, users, brands, retailers, stores, logger }: AuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match?.[1]) throw Errors.authRequired();

    const { uid, email } = await verifier.verify(match[1]);
    const log = { request_id: res.locals.requestId, uid };

    let user: UserRecord | null;
    try {
      user = await users.getById(uid);
    } catch (err) {
      if (!(err instanceof MalformedDocumentError)) throw err;
      logger.error('auth.user_document_malformed', log);
      throw Errors.userMisconfigured();
    }
    if (!user) {
      logger.warn('auth.user_not_provisioned', log);
      throw Errors.userNotProvisioned();
    }
    if (user.status !== 'ACTIVE') throw Errors.userDisabled();

    const role = user.role;
    if (!isRole(role) || !hasValidShape(user, role)) {
      logger.error('auth.user_misconfigured', log);
      throw Errors.userMisconfigured();
    }
    const base = { userId: uid, email: user.email ?? email };

    if (role === 'PLATFORM_ADMIN') {
      res.locals.principal = { ...base, scope: 'PLATFORM', role };
      return next();
    }

    const brand = await brands.getById(user.brandId!);
    if (!brand || brand.status !== 'ACTIVE') throw Errors.brandInactive();
    res.locals.brand = brand;

    // One admin per scope (docs/04_DATA_MODEL.md §4): only the admin recorded on the
    // brand / store document is accepted, so a second admin document grants nothing.
    if (role === 'BRAND_ADMIN') {
      if (brand.brandAdminUserId !== uid) {
        logger.error('auth.not_admin_of_record', { ...log, scope: 'BRAND' });
        throw Errors.userMisconfigured();
      }
      res.locals.principal = { ...base, scope: 'BRAND', role, brandId: brand.brandId };
      return next();
    }

    const retailer = await retailers.get(brand.brandId, user.retailerId!);
    if (!retailer || retailer.status !== 'ACTIVE') throw Errors.retailerInactive();
    const store = await stores.get(brand.brandId, user.storeId!);
    const consistent = isConsistentRetailOwnership({
      userId: uid,
      userRetailerId: user.retailerId!,
      userStoreId: user.storeId!,
      store,
    });
    if (!consistent) {
      logger.error('auth.retail_ownership_mismatch', { ...log, scope: 'RETAIL' });
      throw Errors.userMisconfigured();
    }
    res.locals.retailer = retailer;
    res.locals.store = store!;
    res.locals.principal = {
      ...base,
      scope: 'RETAIL',
      role,
      brandId: brand.brandId,
      retailerId: retailer.retailerId,
      storeId: store!.storeId,
    };
    next();
  };
}
