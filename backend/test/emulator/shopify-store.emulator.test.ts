/**
 * L2-Shopify server-only storage on the Firestore emulator: tokens sealed at rest,
 * one shop per brand, single-use OAuth state under concurrency, Reset demo keeps the
 * connection, and webhook receipts deduplicate.
 *
 * Run from the repo root: npm run test:emulator
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FirestoreDemoDataStore } from '../../src/adapters/firestore/demoDataStore.js';
import { FirestoreWebhookReceiptRepository } from '../../src/adapters/firestore/conversationRepositories.js';
import { FirestoreShopifyConnectionStore } from '../../src/adapters/firestore/shopifyConnectionStore.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { TokenCipher } from '../../src/lib/tokenCipher.js';
import type { ShopifyCredentials } from '../../src/ports/shopify.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

let db: ReturnType<typeof initFirebase>['db'];
let store: FirestoreShopifyConnectionStore;
const cipher = new TokenCipher(Buffer.alloc(32, 9));
const SHOP = 'emu-aquaskin.myshopify.com';

const creds = (brandId: string, shop = SHOP): ShopifyCredentials => ({
  brandId,
  shopDomain: shop,
  shopName: 'AquaSkin',
  accessToken: `shpua_emulator_${brandId}`,
  refreshToken: `shprt_emulator_${brandId}`,
  accessTokenExpiresAt: '2026-10-07T07:30:00.000Z',
  refreshTokenExpiresAt: '2027-01-05T06:30:00.000Z',
  scopes: 'read_products,read_orders',
  installedAt: '2026-10-07T06:30:00.000Z',
});

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  ({ db } = initFirebase(PROJECT, { firestore: FS_HOST, auth: AUTH_HOST }));
  store = new FirestoreShopifyConnectionStore(db, cipher);
});

describe('FirestoreShopifyConnectionStore', () => {
  it('stores tokens sealed (never in plain text), reads them back, and claims the shop for one brand', async () => {
    expect(await store.save(creds('brd_shp_a'))).toBe(true);
    const raw = (await db.doc('brands/brd_shp_a/integrationSecrets/SHOPIFY').get()).data()!;
    expect(JSON.stringify(raw)).not.toMatch(/shpua_emulator|shprt_emulator/);
    expect(raw.access_token).toMatchObject({ iv: expect.any(String), tag: expect.any(String), key_version: 1 });
    expect(await store.get('brd_shp_a')).toEqual(creds('brd_shp_a'));
    expect(await store.brandForShop(SHOP)).toBe('brd_shp_a');
    // Another brand cannot take the same shop; nothing of theirs is written.
    expect(await store.save(creds('brd_shp_b'))).toBe(false);
    expect((await db.doc('brands/brd_shp_b/integrationSecrets/SHOPIFY').get()).exists).toBe(false);
    // The wrong key cannot read the tokens.
    await expect(
      new FirestoreShopifyConnectionStore(db, new TokenCipher(Buffer.alloc(32, 1))).get('brd_shp_a'),
    ).rejects.toThrow();
  });

  it('a refresh replaces the tokens; delete removes the secret and the shop claim', async () => {
    await store.updateTokens('brd_shp_a', {
      accessToken: `shpua_emulator_refreshed`,
      refreshToken: `shprt_emulator_refreshed`,
      accessTokenExpiresAt: '2026-10-07T08:30:00.000Z',
      refreshTokenExpiresAt: '2027-01-05T07:30:00.000Z',
    });
    expect(await store.get('brd_shp_a')).toMatchObject({ accessToken: `shpua_emulator_refreshed` });
    await store.delete('brd_shp_a');
    expect(await store.get('brd_shp_a')).toBeNull();
    expect(await store.brandForShop(SHOP)).toBeNull();
    expect(await store.save(creds('brd_shp_b'))).toBe(true); // the shop is free again
  });

  it('an OAuth state is single-use, even when two callbacks race', async () => {
    const nonce = 'n0nce_emulator_000000001';
    await store.saveNonce(nonce, {
      brandId: 'brd_shp_b',
      userId: 'u1',
      shop: SHOP,
      expiresAt: '2026-10-07T06:40:00.000Z',
    });
    const [a, b] = await Promise.all([store.consumeNonce(nonce), store.consumeNonce(nonce)]);
    expect([a, b].filter(Boolean)).toEqual([
      { brandId: 'brd_shp_b', userId: 'u1', shop: SHOP, expiresAt: '2026-10-07T06:40:00.000Z' },
    ]);
    expect(await store.consumeNonce(nonce)).toBeNull();
    expect(await store.consumeNonce('../../users/x')).toBeNull();
  });

  it('Reset demo keeps the Shopify connection (integrationSecrets is not wiped)', async () => {
    await new FirestoreDemoDataStore(db).wipe('brd_shp_b');
    expect(await store.get('brd_shp_b')).toMatchObject({ shopDomain: SHOP });
  });

  it('webhook receipts: the same Shopify event is processed once', async () => {
    const receipts = new FirestoreWebhookReceiptRepository(db);
    const key = 'shopify:brd_shp_b:orders/create:evt-1';
    const meta = {
      brandId: 'brd_shp_b',
      provider: 'SHOPIFY' as const,
      eventType: 'orders/create',
      externalEventId: 'evt-1',
    };
    expect(await receipts.begin(key, meta, new Date())).toEqual({ state: 'NEW' });
    await receipts.complete(key, { outcome: 'ORDER_RECORDED' });
    expect(await receipts.begin(key, meta, new Date())).toMatchObject({ state: 'DUPLICATE', status: 'PROCESSED' });
  });
});
