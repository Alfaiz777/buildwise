/**
 * Google-signed OIDC identity tokens (L1): Cloud Scheduler calls internal endpoints with an
 * ID token for its service account. The verifier checks the signature, expiry and audience;
 * the caller checks which service account it names.
 */
export interface VerifiedOidcToken {
  email: string;
  emailVerified: boolean;
  audience: string;
}

export interface OidcTokenVerifier {
  /** Throws when the signature, expiry, issuer or audience is not valid. */
  verify(idToken: string, audience: string): Promise<VerifiedOidcToken>;
}
