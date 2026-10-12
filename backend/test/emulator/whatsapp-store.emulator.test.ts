/**
 * L2-WhatsApp server-only storage on the Firestore emulator: token and PIN sealed at rest,
 * one number per brand, disconnect releases the number, delivery statuses never move back,
 * and Reset demo keeps the connection.
 *
 * Run from the repo root: npm run test:emulator
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FirestoreDemoDataStore } from '../../src/adapters/firestore/demoDataStore.js';
import { FirestoreWhatsAppConnectionStore } from '../../src/adapters/firestore/whatsappConnectionStore.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { TokenCipher } from '../../src/lib/tokenCipher.js';
import type { WhatsAppConnection } from '../../src/ports/whatsapp.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

let db: ReturnType<typeof initFirebase>['db'];
let store: FirestoreWhatsAppConnectionStore;
const NUMBER = '300000000000001';

const connection = (brandId: string, phoneNumberId = NUMBER): WhatsAppConnection => ({
  brandId,
  wabaId: '400000000000001',
  phoneNumberId,
  displayPhoneNumber: '+91 98765 43210',
  verifiedName: 'AquaSkin',
  qualityRating: 'GREEN',
  status: 'CONNECTED',
  businessToken: `wa-emulator-token-${brandId}`,
  pin: '135790',
  connectedAt: '2026-10-12T06:30:00.000Z',
  updatedAt: '2026-10-12T06:30:00.000Z',
});

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  ({ db } = initFirebase(PROJECT, { firestore: FS_HOST, auth: AUTH_HOST }));
  store = new FirestoreWhatsAppConnectionStore(db, new TokenCipher(Buffer.alloc(32, 5)));
});

describe('FirestoreWhatsAppConnectionStore', () => {
  it('seals the token and PIN, reads them back, and gives the number to one brand only', async () => {
    expect(await store.save(connection('brd_wa_a'))).toBe(true);
    const raw = (await db.doc('whatsapp_connections/brd_wa_a').get()).data()!;
    expect(JSON.stringify(raw)).not.toMatch(/wa-emulator-token|135790/);
    expect(await store.get('brd_wa_a')).toEqual(connection('brd_wa_a'));
    expect(await store.brandForPhoneNumber(NUMBER)).toBe('brd_wa_a');
    expect(await store.brandsForWaba('400000000000001')).toEqual(['brd_wa_a']);
    expect(await store.save(connection('brd_wa_b'))).toBe(false);
    expect((await db.doc('whatsapp_connections/brd_wa_b').get()).exists).toBe(false);
  });

  it('status updates touch status fields only; delivery statuses never move backwards', async () => {
    await store.updateStatus('brd_wa_a', {
      qualityRating: 'YELLOW',
      status: 'RESTRICTED',
      updatedAt: '2026-10-12T07:00:00.000Z',
    });
    expect(await store.get('brd_wa_a')).toMatchObject({ qualityRating: 'YELLOW', status: 'RESTRICTED', pin: '135790' });
    await store.recordDeliveryStatus('brd_wa_a', { externalMessageId: 'wamid.EMU1', status: 'READ', timestamp: 't2' });
    await store.recordDeliveryStatus('brd_wa_a', {
      externalMessageId: 'wamid.EMU1',
      status: 'DELIVERED',
      timestamp: 't1',
    });
    expect((await db.doc('brands/brd_wa_a/messageStatuses/wamid.EMU1').get()).get('status')).toBe('READ');
  });

  it('Reset demo keeps the connection; disconnect deletes the secrets and frees the number', async () => {
    await new FirestoreDemoDataStore(db).wipe('brd_wa_a');
    expect(await store.get('brd_wa_a')).not.toBeNull();
    await store.disconnect('brd_wa_a', '2026-10-12T08:00:00.000Z');
    expect(await store.get('brd_wa_a')).toBeNull();
    const raw = (await db.doc('whatsapp_connections/brd_wa_a').get()).data()!;
    expect(raw).toMatchObject({ status: 'DISCONNECTED' });
    expect(raw.business_token).toBeUndefined();
    expect(raw.pin).toBeUndefined();
    expect(await store.brandForPhoneNumber(NUMBER)).toBeNull();
    expect(await store.save(connection('brd_wa_b'))).toBe(true);
  });
});
