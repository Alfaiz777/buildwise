import { OAuth2Client } from 'google-auth-library';
import type { OidcTokenVerifier, VerifiedOidcToken } from '../../ports/oidc.js';

/**
 * Verifies Google-signed ID tokens (Cloud Scheduler's OIDC tokens) with Google's public keys:
 * signature, expiry, issuer (accounts.google.com) and audience. Needs no credentials or IAM role.
 */
export class GoogleOidcVerifier implements OidcTokenVerifier {
  private readonly client = new OAuth2Client();

  async verify(idToken: string, audience: string): Promise<VerifiedOidcToken> {
    const ticket = await this.client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new Error('OIDC token has no email');
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    return { email: payload.email, emailVerified: payload.email_verified === true, audience: String(aud) };
  }
}
