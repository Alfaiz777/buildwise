import { createApp } from '../src/app.js';
import type { TokenVerifier, VerifiedToken } from '../src/auth/tokenVerifier.js';
import { AppError, Errors } from '../src/lib/errors.js';
import { silentLogger } from '../src/lib/logger.js';
import type { BrandRecord, BrandRepository, UserRecord, UserRepository } from '../src/repositories/types.js';

/** Token → identity map standing in for Firebase. Special tokens simulate failures. */
export class FakeVerifier implements TokenVerifier {
  constructor(private readonly tokens: Record<string, VerifiedToken>) {}
  async verify(idToken: string): Promise<VerifiedToken> {
    if (idToken === 'expired-token') throw Errors.authExpired();
    if (idToken === 'firebase-down') throw Errors.authUnavailable();
    const identity = this.tokens[idToken];
    if (!identity) throw Errors.authInvalid();
    return identity;
  }
}

export class MemoryUsers implements UserRepository {
  constructor(private readonly users: UserRecord[]) {}
  async getById(userId: string) {
    return this.users.find((u) => u.userId === userId) ?? null;
  }
}

export class MemoryBrands implements BrandRepository {
  constructor(private readonly brands: BrandRecord[]) {}
  async getById(brandId: string) {
    return this.brands.find((b) => b.brandId === brandId) ?? null;
  }
}

export const BRAND_A: BrandRecord = { brandId: 'brand_A', name: 'Brand A', status: 'ACTIVE' };
export const BRAND_B: BrandRecord = { brandId: 'brand_B', name: 'Brand B', status: 'ACTIVE' };
export const BRAND_SUSPENDED: BrandRecord = { brandId: 'brand_S', name: 'Suspended', status: 'SUSPENDED' };

const user = (userId: string, brandId: string, role: string, extra: Partial<UserRecord> = {}): UserRecord => ({
  userId,
  brandId,
  role,
  storeIds: [],
  email: `${userId}@example.test`,
  status: 'ACTIVE',
  ...extra,
});

export const USERS: UserRecord[] = [
  user('admin_a', 'brand_A', 'BRAND_ADMIN'),
  user('marketing_a', 'brand_A', 'BRAND_MARKETING'),
  user('staff_a', 'brand_A', 'RETAIL_STAFF', { storeIds: ['store_1'] }),
  user('admin_b', 'brand_B', 'BRAND_ADMIN'),
  user('disabled_a', 'brand_A', 'BRAND_ADMIN', { status: 'DISABLED' }),
  user('badrole_a', 'brand_A', 'SUPERUSER'),
  user('storeless_staff_a', 'brand_A', 'RETAIL_STAFF', { storeIds: [] }),
  user('admin_suspended', 'brand_S', 'BRAND_ADMIN'),
];

/** Every user above gets a token named `token-<userId>`; plus one unprovisioned uid. */
const tokens: Record<string, VerifiedToken> = Object.fromEntries(
  USERS.map((u) => [`token-${u.userId}`, { uid: u.userId, email: u.email }]),
);
tokens['token-unprovisioned'] = { uid: 'nobody', email: 'nobody@example.test' };

export function buildTestApp(overrides: { corsAllowedOrigins?: string[] } = {}) {
  return createApp({
    config: { corsAllowedOrigins: overrides.corsAllowedOrigins ?? [] },
    logger: silentLogger,
    verifier: new FakeVerifier(tokens),
    users: new MemoryUsers(USERS),
    brands: new MemoryBrands([BRAND_A, BRAND_B, BRAND_SUSPENDED]),
  });
}

export const bearer = (userId: string) => `Bearer token-${userId}`;

export { AppError };
