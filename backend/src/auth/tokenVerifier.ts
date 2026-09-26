import type { Auth } from 'firebase-admin/auth';
import { Errors } from '../lib/errors.js';

export interface VerifiedToken {
  uid: string;
  email: string | null;
}

/** Verifies a Firebase ID token. Throws an AppError (401 or 503) on failure. */
export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedToken>;
}

/** Firebase error codes that mean "this token is not acceptable" (client's problem → 401). */
const INVALID_TOKEN_CODES = new Set([
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/id-token-revoked',
  'auth/user-disabled',
  'auth/user-not-found',
]);

export class FirebaseTokenVerifier implements TokenVerifier {
  constructor(private readonly auth: Auth) {}

  async verify(idToken: string): Promise<VerifiedToken> {
    try {
      // Checks signature, expiry, audience (= Firebase project) and issuer.
      const decoded = await this.auth.verifyIdToken(idToken);
      return { uid: decoded.uid, email: decoded.email ?? null };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'auth/id-token-expired') throw Errors.authExpired();
      if (typeof code === 'string' && INVALID_TOKEN_CODES.has(code)) throw Errors.authInvalid();
      // e.g. failure fetching Google public keys: not the client's fault, retryable.
      throw Errors.authUnavailable();
    }
  }
}
