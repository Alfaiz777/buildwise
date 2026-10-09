import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { SealedSecret, TokenCipher } from '../../lib/tokenCipher.js';
import type { OAuthNonce, ShopifyConnectionStore, ShopifyCredentials } from '../../ports/shopify.js';

const SECRET_ID = 'SHOPIFY';
const shopKey = (shop: string) => shop.toLowerCase();

/**
 * Server-only Shopify storage (L2-Shopify; docs/04, docs/07 §9):
 *   brands/{brandId}/integrationSecrets/SHOPIFY — tokens sealed with AES-256-GCM
 *   shopifyShops/{shop}                         — { brand_id }: one shop belongs to one brand
 *   oauthStates/{nonce}                         — single-use OAuth state, deleted on use
 * Firestore rules deny every client; Reset demo never wipes these collections.
 */
export class FirestoreShopifyConnectionStore implements ShopifyConnectionStore {
  constructor(
    private readonly db: Firestore,
    private readonly cipher: TokenCipher,
  ) {}

  private secret(brandId: string) {
    return this.db.collection('brands').doc(brandId).collection('integrationSecrets').doc(SECRET_ID);
  }

  private shop(shop: string) {
    return this.db.collection('shopifyShops').doc(shopKey(shop));
  }

  async get(brandId: string): Promise<ShopifyCredentials | null> {
    const snap = await this.secret(brandId).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return {
      brandId,
      shopDomain: d.shop_domain,
      shopName: d.shop_name ?? d.shop_domain,
      accessToken: this.cipher.open(d.access_token as SealedSecret),
      refreshToken: d.refresh_token ? this.cipher.open(d.refresh_token as SealedSecret) : null,
      accessTokenExpiresAt: d.access_token_expires_at ?? null,
      refreshTokenExpiresAt: d.refresh_token_expires_at ?? null,
      scopes: d.scopes ?? '',
      installedAt: d.installed_at,
    };
  }

  async save(c: ShopifyCredentials): Promise<boolean> {
    const secretRef = this.secret(c.brandId);
    const shopRef = this.shop(c.shopDomain);
    return this.db.runTransaction(async (tx) => {
      const [claim, previous] = await Promise.all([tx.get(shopRef), tx.get(secretRef)]);
      if (claim.exists && claim.get('brand_id') !== c.brandId) return false;
      const oldShop = previous.exists ? (previous.get('shop_domain') as string) : null;
      if (oldShop && shopKey(oldShop) !== shopKey(c.shopDomain)) tx.delete(this.shop(oldShop));
      tx.set(shopRef, {
        shop_domain: shopKey(c.shopDomain),
        brand_id: c.brandId,
        updated_at: FieldValue.serverTimestamp(),
      });
      tx.set(secretRef, {
        brand_id: c.brandId,
        provider: 'SHOPIFY',
        shop_domain: shopKey(c.shopDomain),
        shop_name: c.shopName,
        access_token: this.cipher.seal(c.accessToken),
        refresh_token: c.refreshToken ? this.cipher.seal(c.refreshToken) : null,
        access_token_expires_at: c.accessTokenExpiresAt,
        refresh_token_expires_at: c.refreshTokenExpiresAt,
        scopes: c.scopes,
        installed_at: c.installedAt,
        updated_at: FieldValue.serverTimestamp(),
      });
      return true;
    });
  }

  async updateTokens(
    brandId: string,
    t: Pick<ShopifyCredentials, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>,
  ): Promise<void> {
    await this.secret(brandId).update({
      access_token: this.cipher.seal(t.accessToken),
      refresh_token: t.refreshToken ? this.cipher.seal(t.refreshToken) : null,
      access_token_expires_at: t.accessTokenExpiresAt,
      refresh_token_expires_at: t.refreshTokenExpiresAt,
      updated_at: FieldValue.serverTimestamp(),
    });
  }

  async delete(brandId: string): Promise<void> {
    const secretRef = this.secret(brandId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(secretRef);
      if (!snap.exists) return;
      const shop = snap.get('shop_domain') as string;
      const claim = await tx.get(this.shop(shop));
      if (claim.exists && claim.get('brand_id') === brandId) tx.delete(claim.ref);
      tx.delete(secretRef);
    });
  }

  async brandForShop(shopDomain: string): Promise<string | null> {
    const snap = await this.shop(shopDomain).get();
    return snap.exists ? (snap.get('brand_id') as string) : null;
  }

  async saveNonce(nonce: string, value: OAuthNonce): Promise<void> {
    await this.db.collection('oauthStates').doc(nonce).set({
      provider: 'SHOPIFY',
      brand_id: value.brandId,
      user_id: value.userId,
      shop: value.shop,
      expires_at: value.expiresAt,
    });
  }

  async consumeNonce(nonce: string): Promise<OAuthNonce | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
    const ref = this.db.collection('oauthStates').doc(nonce);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.delete(ref);
      const d = snap.data()!;
      return { brandId: d.brand_id, userId: d.user_id, shop: d.shop, expiresAt: d.expires_at };
    });
  }
}
