import type { Role } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import type { IdentityAdmin } from '../ports/identity.js';
import { ConflictError, DomainConflictError, type AdminSlot, type UserRepository } from '../ports/repositories.js';

export interface ProvisioningDeps {
  identity: IdentityAdmin;
  users: UserRepository;
}

export interface ProvisionRequest {
  email: string;
  role: Role;
  brandId: string | null;
  retailerId: string | null;
  /** RETAIL_ADMIN only: the one store it operates. */
  storeId: string | null;
}

export interface ProvisionedUser {
  userId: string;
  email: string;
  role: Role;
  /** Admin SDK password-reset link; handed over manually (no email service in the MVP). */
  passwordSetupLink: string;
}

/** The scope's single-admin slot and the error returned when it is already taken. */
export interface SingleAdminSlot {
  slot: AdminSlot;
  /** Current holder, from the scope document (fast pre-check; the claim is authoritative). */
  currentHolder: string | null;
  conflictCode: string;
  conflictMessage: string;
}

/**
 * Creates (or reuses) the Firebase Auth user, claims the scope's single admin
 * slot and writes users/{uid}. The MVP has exactly one admin per scope
 * (docs/04_DATA_MODEL.md §4): one BRAND_ADMIN per brand, one RETAIL_ADMIN per
 * store. An existing Buildwise user is never silently moved or re-scoped.
 * Callers are responsible for authorization.
 */
export async function provisionUser(
  deps: ProvisioningDeps,
  request: ProvisionRequest,
  admin: SingleAdminSlot,
): Promise<ProvisionedUser> {
  const email = request.email.trim().toLowerCase();
  const slotTaken = () => Errors.conflict(admin.conflictCode, admin.conflictMessage);

  if (admin.currentHolder) throw slotTaken();

  let uid = await deps.identity.findUidByEmail(email);
  if (uid) {
    const existing = await deps.users.getById(uid);
    if (existing) {
      throw existing.brandId === request.brandId
        ? Errors.conflict('USER_ALREADY_PROVISIONED', 'This user already has access.')
        : Errors.conflict('USER_EXISTS_IN_OTHER_BRAND', 'This email already belongs to another account.');
    }
  } else {
    uid = await deps.identity.createUser(email);
  }

  try {
    await admin.slot.claimAdmin(uid);
  } catch (err) {
    if (err instanceof ConflictError) throw slotTaken();
    if (err instanceof DomainConflictError && err.code === 'STORE_HAS_NO_RETAILER') {
      throw Errors.conflict(err.code, 'This store does not belong to a retailer yet.');
    }
    throw err;
  }

  try {
    await deps.users.create({
      userId: uid,
      role: request.role,
      brandId: request.brandId,
      retailerId: request.retailerId,
      storeId: request.storeId,
      email,
    });
  } catch (err) {
    await admin.slot.releaseAdmin(uid);
    if (err instanceof ConflictError)
      throw Errors.conflict('USER_ALREADY_PROVISIONED', 'This user already has access.');
    throw err;
  }

  const passwordSetupLink = await deps.identity.createPasswordSetupLink(email);
  return { userId: uid, email, role: request.role, passwordSetupLink };
}
