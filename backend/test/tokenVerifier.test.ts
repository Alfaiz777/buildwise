import type { Auth } from 'firebase-admin/auth';
import { describe, expect, it } from 'vitest';
import { FirebaseTokenVerifier } from '../src/auth/tokenVerifier.js';
import type { AppError } from '../src/lib/errors.js';

const failingAuth = (code: string) =>
  ({
    verifyIdToken: async () => {
      throw Object.assign(new Error('firebase error'), { code });
    },
  }) as unknown as Auth;

async function errorFor(code: string) {
  try {
    await new FirebaseTokenVerifier(failingAuth(code)).verify('t');
    throw new Error('expected failure');
  } catch (err) {
    return { status: (err as AppError).status, code: (err as AppError).code };
  }
}

describe('FirebaseTokenVerifier error mapping', () => {
  it('maps an expired token to 401 AUTH_EXPIRED', async () => {
    expect(await errorFor('auth/id-token-expired')).toEqual({ status: 401, code: 'AUTH_EXPIRED' });
  });

  it('maps malformed / bad-signature / revoked tokens to 401 AUTH_INVALID', async () => {
    for (const code of ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-revoked']) {
      expect(await errorFor(code)).toEqual({ status: 401, code: 'AUTH_INVALID' });
    }
  });

  it('maps infrastructure failures to 503 AUTH_UNAVAILABLE', async () => {
    expect(await errorFor('auth/internal-error')).toEqual({ status: 503, code: 'AUTH_UNAVAILABLE' });
  });

  it('returns uid and email on success', async () => {
    const auth = { verifyIdToken: async () => ({ uid: 'u1', email: 'a@b.test' }) } as unknown as Auth;
    expect(await new FirebaseTokenVerifier(auth).verify('t')).toEqual({ uid: 'u1', email: 'a@b.test' });
  });
});
