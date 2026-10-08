/**
 * Shopify-specific ports (L2-Shopify; docs/06 §9). The credentials never leave the backend:
 * no API response, log line, URL or browser storage ever carries a token or the app secret.
 */

/** A brand's Shopify connection with its decrypted tokens — application code only. */
export interface ShopifyCredentials {
  brandId: string;
  shopDomain: string;
  shopName: string;
  accessToken: string;
  /** Expiring offline tokens (the current default) come with a refresh token. */
  refreshToken: string | null;
  /** ISO-8601; null for a non-expiring token. */
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string;
  installedAt: string;
}

export interface OAuthNonce {
  brandId: string;
  userId: string;
  shop: string;
  /** ISO-8601 */
  expiresAt: string;
}

/**
 * Server-only storage: brands/{brandId}/integrationSecrets/SHOPIFY (tokens encrypted with
 * AES-256-GCM), shopifyShops/{shop} → brand, oauthStates/{nonce}. Firestore rules deny clients.
 */
export interface ShopifyConnectionStore {
  get(brandId: string): Promise<ShopifyCredentials | null>;
  /** Saves (or replaces) the brand's credentials and claims the shop; false if another brand holds the shop. */
  save(credentials: ShopifyCredentials): Promise<boolean>;
  /** Replaces only the tokens (after a refresh). */
  updateTokens(
    brandId: string,
    tokens: Pick<ShopifyCredentials, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>,
  ): Promise<void>;
  /** Deletes the credentials and the shop claim. */
  delete(brandId: string): Promise<void>;
  brandForShop(shopDomain: string): Promise<string | null>;
  saveNonce(nonce: string, value: OAuthNonce): Promise<void>;
  /** Single use: returns the nonce's value the first time (and deletes it), null afterwards or when unknown. */
  consumeNonce(nonce: string): Promise<OAuthNonce | null>;
}

export interface ShopifyTokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string;
}

/** Normalized failures of the Shopify Admin API; never the provider's raw message. */
export class ShopifyApiError extends Error {
  constructor(
    readonly kind: 'UNAUTHORIZED' | 'THROTTLED' | 'FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

/** The Shopify HTTP surface Qwikspot uses: OAuth token endpoints and the GraphQL Admin API. */
export interface ShopifyAdminApi {
  exchangeCode(shop: string, code: string): Promise<ShopifyTokenSet>;
  refresh(shop: string, refreshToken: string): Promise<ShopifyTokenSet>;
  graphql<T>(shop: string, accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T>;
}
