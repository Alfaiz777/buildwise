/**
 * L4 plain prefill on the Firestore emulator: FirestoreIntentTokenRepository.listOpenByTextHash
 * returns this brand's tokens for a prefilled sentence that are neither consumed nor expired, and
 * the text itself is never stored (only its hash).
 *
 * Run from the repo root: npm run test:emulator
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FirestoreIntentTokenRepository } from '../../src/adapters/firestore/conversationRepositories.js';
import { prefillTextHash } from '../../src/domain/intentToken.js';
import { initFirebase } from '../../src/firebase/admin.js';
import type { IntentTokenRecord } from '../../src/ports/conversationRepositories.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const SENTENCE = "Hi AquaSkin! I'd like Mineral Sunscreen SPF 50 (50 g) today. Is it available at a store near me?";
const NOW = '2026-10-14T10:00:00.000Z';
let repo: FirestoreIntentTokenRepository;
let db: ReturnType<typeof initFirebase>['db'];

const token = (id: string, over: Partial<IntentTokenRecord> = {}): IntentTokenRecord => ({
  tokenHash: `hash_${id}`,
  brandId: 'brd_prefill',
  intentId: `int_${id}`,
  webSessionId: `ws_${id}_00000000`,
  issuedAt: '2026-10-14T09:55:00.000Z',
  expiresAt: '2026-10-14T10:25:00.000Z',
  consumedAt: null,
  consumedByCustomerId: null,
  textHash: prefillTextHash(SENTENCE),
  ...over,
});

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  ({ db } = initFirebase(PROJECT, { firestore: FS_HOST, auth: AUTH_HOST }));
  repo = new FirestoreIntentTokenRepository(db);
  await repo.create(token('open'));
  await repo.create(token('open2', { issuedAt: '2026-10-14T09:59:00.000Z' }));
  await repo.create(token('expired', { expiresAt: '2026-10-14T09:59:59.000Z' }));
  await repo.create(token('other_brand', { brandId: 'brd_someone_else' }));
  await repo.create(token('other_text', { textHash: prefillTextHash('Hi AquaSkin! I have a question.') }));
  await repo.create(token('consumed'));
  await db
    .collection('intentTokens')
    .doc('hash_consumed')
    .update({ consumed_at: NOW, consumed_by_customer_id: 'cus_x' });
});

describe('FirestoreIntentTokenRepository.listOpenByTextHash', () => {
  it("returns only this brand's open, unexpired tokens for the sentence", async () => {
    const open = await repo.listOpenByTextHash('brd_prefill', prefillTextHash(SENTENCE), NOW);
    expect(open.map((t) => t.tokenHash).sort()).toEqual(['hash_open', 'hash_open2']);
    expect(open[0]!.textHash).toBe(prefillTextHash(SENTENCE));
  });

  it('a slightly different but equivalent sentence finds the same tokens; nothing for an unknown sentence', async () => {
    expect(
      await repo.listOpenByTextHash('brd_prefill', prefillTextHash(`${SENTENCE.toLowerCase()} `), NOW),
    ).toHaveLength(2);
    expect(
      await repo.listOpenByTextHash('brd_prefill', prefillTextHash('something else entirely, typed by hand'), NOW),
    ).toEqual([]);
  });

  it('stores the hash, never the sentence', async () => {
    const docs = (await db.collection('intentTokens').get()).docs.map((d) => d.data());
    expect(JSON.stringify(docs)).not.toMatch(/Mineral|AquaSkin|Sunscreen/);
  });
});
