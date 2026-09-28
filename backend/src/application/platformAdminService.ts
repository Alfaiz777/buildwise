import type { PlatformPrincipal } from '../domain/principal.js';
import { Errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { IdentityAdmin } from '../ports/identity.js';
import type {
  AuditRepository,
  BrandRecord,
  BrandRepository,
  PlatformAuditRecord,
  UserRepository,
} from '../ports/repositories.js';
import { provisionUser, type ProvisionedUser } from './provisioning.js';

export interface PlatformAdminDeps {
  brands: BrandRepository;
  users: UserRepository;
  identity: IdentityAdmin;
  audit: AuditRepository;
}

/**
 * Platform-scope operations (docs/07_SECURITY_SPEC.md §4.2, docs/06_INTEGRATION_CONTRACTS.md §14.6).
 * Every state change writes a PlatformAuditEvent (+ the brand's mirrored AuditEvent).
 * Nothing here reads customer data or conversations.
 */
export class PlatformAdminService {
  constructor(private readonly deps: PlatformAdminDeps) {}

  listBrands(): Promise<BrandRecord[]> {
    return this.deps.brands.list();
  }

  async createBrand(actor: PlatformPrincipal, name: string): Promise<BrandRecord> {
    const brand = await this.deps.brands.create({ brandId: newId('brd'), name: name.trim() });
    await this.deps.audit.recordPlatformEvent({
      actorId: actor.userId,
      action: 'BRAND_CREATED',
      targetBrandId: brand.brandId,
      targetType: 'BRAND',
      targetId: brand.brandId,
      result: 'SUCCESS',
      reasonCode: null,
    });
    return brand;
  }

  async setBrandStatus(
    actor: PlatformPrincipal,
    brandId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string | null,
  ): Promise<BrandRecord> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();
    await this.deps.brands.setStatus(brandId, status);
    await this.deps.audit.recordPlatformEvent({
      actorId: actor.userId,
      action: status === 'SUSPENDED' ? 'BRAND_SUSPENDED' : 'BRAND_REACTIVATED',
      targetBrandId: brandId,
      targetType: 'BRAND',
      targetId: brandId,
      result: 'SUCCESS',
      reasonCode: reason,
    });
    return { ...brand, status };
  }

  async provisionBrandAdmin(actor: PlatformPrincipal, brandId: string, email: string): Promise<ProvisionedUser> {
    const brand = await this.deps.brands.getById(brandId);
    if (!brand) throw Errors.notFound();
    const user = await provisionUser(
      this.deps,
      { email, role: 'BRAND_ADMIN', brandId, retailerId: null, storeId: null },
      {
        slot: this.deps.brands.adminSlot(brandId),
        currentHolder: brand.brandAdminUserId,
        conflictCode: 'BRAND_ADMIN_ALREADY_PROVISIONED',
        conflictMessage: 'This brand already has its Brand Admin. The MVP allows exactly one per brand.',
      },
    );
    await this.deps.audit.recordPlatformEvent({
      actorId: actor.userId,
      action: 'BRAND_ADMIN_PROVISIONED',
      targetBrandId: brandId,
      targetType: 'USER',
      targetId: user.userId,
      result: 'SUCCESS',
      reasonCode: null,
    });
    return user;
  }

  listAudit(limit = 50): Promise<PlatformAuditRecord[]> {
    return this.deps.audit.listPlatformEvents(limit);
  }
}
