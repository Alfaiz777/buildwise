/**
 * L5 reply ceiling on the Firebase emulators: the rules runtime — what answers when Gemini is
 * slow — decides a store search, a typed store name and a closing against real Firestore well
 * inside its 2 s slot (AI_BACKUP_BUDGET_MS). Measured from the conversation.reply_timing line.
 *
 * Run from the repo root: npm run test:emulator
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AI_BACKUP_BUDGET_MS } from '../../src/application/conversation/agentStage.js';
import { buildContainer } from '../../src/composition/container.js';
import { loadConfig } from '../../src/config/env.js';
import { initFirebase } from '../../src/firebase/admin.js';
import type { Logger } from '../../src/lib/logger.js';

const PROJECT = 'demo-qwikspot';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) {
  throw new Error(
    'Emulator tests need FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST (npm run test:emulator)',
  );
}

const DEMO = 'brd_timing_demo';
const PASSWORD = 'password-123';
const SEED = { type: 'SYSTEM' as const, id: 'seed-test' };

let dataDir = '';
let app: ReturnType<typeof createApp>;
let token = '';
let n = 0;
const timings: Record<string, unknown>[] = [];
const logger: Logger = {
  debug() {},
  warn() {},
  error() {},
  info(message, fields) {
    if (message === 'conversation.reply_timing' && fields) timings.push(fields);
  },
};

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  dataDir = await mkdtemp(join(tmpdir(), 'qwikspot-timing-'));
  const config = loadConfig({
    ...process.env,
    QWIKSPOT_PROFILE: 'local',
    GOOGLE_CLOUD_PROJECT: PROJECT,
    LOCAL_DATA_DIR: dataDir,
    DEMO_MODE: 'true',
    DEMO_BRAND_IDS: DEMO,
  });
  const container = buildContainer(config, logger);
  app = createApp(container.appDeps);
  const { db, auth } = initFirebase(PROJECT, config.emulators);
  await db.doc(`brands/${DEMO}`).set({ brand_id: DEMO, name: 'Demo Beauty Co', status: 'ACTIVE', settings: {} });
  await db
    .doc(`brands/${DEMO}/retailers/rtl_north`)
    .set({ retailer_id: 'rtl_north', brand_id: DEMO, name: 'Ahmedabad Retail Partners', status: 'ACTIVE' });
  await container.demoReset.rebuild(DEMO, SEED); // the judge stock file and four weeks of history
  const email = 'admin@timing-demo.test';
  const { uid } = await auth.createUser({ email, password: PASSWORD });
  await db.doc(`users/${uid}`).set({
    user_id: uid,
    role: 'BRAND_ADMIN',
    brand_id: DEMO,
    retailer_id: null,
    store_id: null,
    email,
    status: 'ACTIVE',
  });
  await db.doc(`brands/${DEMO}`).update({ brand_admin_user_id: uid });
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    },
  );
  token = ((await res.json()) as { idToken: string }).idToken;
}, 180_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const say = (text: string) =>
  request(app)
    .post('/api/channels/simulator/messages')
    .set('Authorization', `Bearer ${token}`)
    .send({ simulator_customer_ref: 'timing_1', client_message_id: `cm_t_${++n}`, content: { type: 'TEXT', text } });

describe('the rules runtime fits its 2 s backup slot against Firestore', () => {
  it('a store search, a typed store name and a closing are each decided well under 2 s', async () => {
    for (const [text, action] of [
      ['I need Vitamin C Glow Serum 30 ml today near Satellite', 'STORE_DISCOVERY'],
      ["I'll go to GlowUp", 'STORE_DISCOVERY'],
      ['Thanks, I will buy it later', 'NO_ACTION'],
    ] as const) {
      const res = await say(text);
      expect(res.body.decision?.action, text).toBe(action);
      const line = timings.at(-1)!;
      expect(line).toMatchObject({ path: expect.stringMatching(/^(MOCK|RULES_TAP)$/), gemini_ms: null });
      expect(Number(line.rules_ms), `${text}: ${line.rules_ms} ms`).toBeLessThan(AI_BACKUP_BUDGET_MS / 2);
    }
  }, 60_000);
});
