import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Errors } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { MalformedDocumentError } from '../repositories/errors.js';
import type { BrandRecord, BrandRepository, UserRepository } from '../repositories/types.js';
import type { TokenVerifier } from './tokenVerifier.js';
import { ROLES, isRetailRole, type Principal, type Role } from './types.js';

export interface AuthDeps {
  verifier: TokenVerifier;
  users: UserRepository;
  brands: BrandRepository;
  logger: Logger;
}

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      principal?: Principal;
      brand?: BrandRecord;
    }
  }
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Steps 1–2 of the auth chain (docs/07_SECURITY_SPEC.md §4.1):
 *   1. verify the Firebase ID token            → 401 on failure
 *   2. resolve user / brand / role from users/{uid} → 403 on failure
 * On success res.locals.principal and res.locals.brand are set.
 * Nothing in the request body, query or path influences the principal.
 */
export function authenticate({ verifier, users, brands, logger }: AuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match?.[1]) throw Errors.authRequired();

    const { uid, email } = await verifier.verify(match[1]);

    let user;
    try {
      user = await users.getById(uid);
    } catch (err) {
      if (!(err instanceof MalformedDocumentError)) throw err;
      logger.error('auth.user_document_malformed', { request_id: res.locals.requestId, uid });
      throw Errors.userMisconfigured();
    }
    if (!user) {
      logger.warn('auth.user_not_provisioned', { request_id: res.locals.requestId, uid });
      throw Errors.userNotProvisioned();
    }
    if (user.status !== 'ACTIVE') throw Errors.userDisabled();

    if (!isRole(user.role) || (isRetailRole(user.role) && user.storeIds.length === 0)) {
      logger.error('auth.user_misconfigured', { request_id: res.locals.requestId, uid });
      throw Errors.userMisconfigured();
    }

    const brand = await brands.getById(user.brandId);
    if (!brand || brand.status !== 'ACTIVE') throw Errors.brandInactive();

    res.locals.principal = {
      userId: uid,
      email: user.email ?? email,
      brandId: user.brandId,
      role: user.role,
      storeIds: isRetailRole(user.role) ? [...user.storeIds] : [],
    };
    res.locals.brand = brand;
    next();
  };
}
