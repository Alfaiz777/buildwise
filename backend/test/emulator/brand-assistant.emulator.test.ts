/**
 * L5 Ask Qwikspot on the Firebase emulators with the REAL composition root (mock runtime, so
 * every answer is the rules Quick summary): the brand pack builds from real Firestore data, a
 * conversation's summary is kept as `ai_summary` on the conversation document, and Reset demo
 * (which wipes conversations) clears it.
 *
 * Run from the repo root: npm run test:emulator
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirestoreConversationSummaryStore } from '../../src/adapters/firestore/conversationSummaryStore.js';
import { buildContainer } from '../../src/composition/container.js';
import { loadConfig } from '../../src/config/env.js';
import type { BrandPrincipal } from '../../src/domain/principal.js';
import { initFirebase } from '../../src/firebase/admin.js';
import { silentLogger } from '../../src/lib/logger.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const DEMO = 'brd_assistant_demo';
const SEED = { type: 'SYSTEM' as const, id: 'seed-test' };
const principal: BrandPrincipal = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  brandId: DEMO,
  userId: 'u_admin',
  email: null,
};

let dataDir = '';
let db: ReturnType<typeof initFirebase>['db'];
let container: ReturnType<typeof buildContainer>;

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'qwikspot-assistant-'));
  const config = loadConfig({
    ...process.env,
    QWIKSPOT_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
    DEMO_MODE: 'true',
    DEMO_BRAND_IDS: DEMO,
  });
  container = buildContainer(config, silentLogger);
  ({ db } = initFirebase(PROJECT, config.emulators));
  await db.doc(`brands/${DEMO}`).set({ brand_id: DEMO, name: 'Demo Beauty Co', status: 'ACTIVE', settings: {} });
  await db
    .doc(`brands/${DEMO}/retailers/rtl_north`)
    .set({ retailer_id: 'rtl_north', brand_id: DEMO, name: 'Ahmedabad Retail Partners', status: 'ACTIVE' });
  await container.demoReset.rebuild(DEMO, SEED); // the judge stock file and four weeks of synthetic history
}, 180_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('Ask Qwikspot against Firestore', () => {
  it('the brand pack builds from real data: the six stores, no shopper, and a Quick brief from it', async () => {
    const assistant = container.appDeps.services.brandAssistant!;
    const pack = await assistant.pack(principal);
    expect(pack.brand_name).toBe('Demo Beauty Co');
    expect(pack.stores.map((s) => s.name).sort()).toEqual([
      'CityCare Pharmacy',
      'GlowUp Beauty',
      'HealthPlus Chemist',
      'MediGlow Pharmacy',
      'Skin Studio',
      'Wellness Mart',
    ]);
    expect(pack.totals.shopper_intents).toBeGreaterThan(0); // the synthetic history
    expect(JSON.stringify(pack)).not.toMatch(/customer_id|customer_ref|pickup_code|hist_\d/);
    const brief = await assistant.brief(principal);
    expect(brief).toMatchObject({ source: 'QUICK_SUMMARY' });
    expect(brief.answer).toMatch(/^In the last 7 days: /);
  }, 60_000);

  it('a summary is kept as ai_summary on the conversation document; Reset demo clears it', async () => {
    const conversation = (await db.collection(`brands/${DEMO}/conversations`).limit(1).get()).docs[0]!;
    const store = new FirestoreConversationSummaryStore(db);
    await store.put(DEMO, conversation.id, {
      summary: 'The shopper wanted a serum.',
      handoffBrief: null,
      messageCount: 4,
      generatedAt: '2026-10-16T06:00:00.000Z',
      model: 'gemini-test',
    });
    expect(await store.get(DEMO, conversation.id)).toEqual({
      summary: 'The shopper wanted a serum.',
      handoffBrief: null,
      messageCount: 4,
      generatedAt: '2026-10-16T06:00:00.000Z',
      model: 'gemini-test',
    });
    expect((await conversation.ref.get()).get('ai_summary')).toMatchObject({ message_count: 4 });
    await container.demoReset.rebuild(DEMO, SEED);
    expect(await store.get(DEMO, conversation.id)).toBeNull();
  }, 180_000);
});
