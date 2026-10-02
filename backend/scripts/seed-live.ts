/**
 * npm run seed:live -- --project <id> [--brand brd_demo] [--confirm <id>]
 *
 * Builds the judged demo in a REAL project (L1/L3) with the same code paths as the product:
 *   1. the Platform Admin (bootstrap, as seed:platform-admin);
 *   2. the demo brand and its two retailers (fixed ids the judge stock fixture refers to);
 *   3. DemoResetService.rebuild(): catalogue sync, judge stock import, synthetic history;
 *   4. the Brand Admin (PlatformAdminService) and the Bandra / Andheri Retail Admins
 *      (TenantAdminService) — audited like in-product provisioning;
 *   5. the four demo users' password = DEMO_PASSWORD (from the environment, never the repo).
 * Re-runnable: existing users and admins are kept, the demo data is rebuilt.
 * Guard: scripts/seedLiveGuard.ts. Rehearse against the emulators with
 * `--project demo-buildwise` (local profile). Runbook: docs/12_DEPLOYMENT_RUNBOOK.md.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import { buildContainer } from '../src/composition/container.js';
import { loadConfig } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { silentLogger } from '../src/lib/logger.js';
import { checkSeedLive, confirmationMatches, SeedLiveRefused, type SeedLivePlan } from './seedLiveGuard.js';

const { values } = parseArgs({
  options: { project: { type: 'string' }, brand: { type: 'string' }, confirm: { type: 'string' } },
});

function refuse(message: string): never {
  console.error(`seed:live refused: ${message}`);
  process.exit(1);
}

let plan: SeedLivePlan;
try {
  plan = checkSeedLive({ args: values, env: process.env });
} catch (err) {
  if (err instanceof SeedLiveRefused) refuse(err.message);
  throw err;
}

const config = loadConfig();
if (config.projectId !== plan.projectId) refuse(`the configured project is ${config.projectId}, not ${plan.projectId}`);

let typed = values.confirm;
if (typed === undefined) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  typed = await rl.question(
    `This writes demo users and data into ${plan.projectId}${config.usingEmulators ? ' (emulators)' : ''}. ` +
      'Type the project id to continue: ',
  );
  rl.close();
}
if (!confirmationMatches(typed, plan.projectId)) refuse('the typed project id did not match');

const { auth, db } = initFirebase(config.projectId, config.emulators);
const container = buildContainer(config, silentLogger);
const { brands, retailers, stores } = container.appDeps.repositories;
const { platformAdmin, tenantAdmin } = container.appDeps.services;
const SEED = { type: 'SYSTEM' as const, id: 'seed-live' };

async function authUser(email: string): Promise<string> {
  try {
    const uid = (await auth.getUserByEmail(email)).uid;
    await auth.updateUser(uid, { password: plan.password });
    return uid;
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    return (await auth.createUser({ email, password: plan.password })).uid;
  }
}

// 1. Platform Admin (the only user not provisioned in-product).
const platformUid = await authUser(plan.emails.platform);
const platformDoc = db.collection('users').doc(platformUid);
if (!(await platformDoc.get()).exists) {
  await platformDoc.create({
    user_id: platformUid,
    role: 'PLATFORM_ADMIN',
    brand_id: null,
    retailer_id: null,
    store_id: null,
    email: plan.emails.platform,
    status: 'ACTIVE',
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });
}
console.log('✔ Platform Admin');
const platform = {
  scope: 'PLATFORM',
  role: 'PLATFORM_ADMIN',
  userId: platformUid,
  email: plan.emails.platform,
} as const;

// 2. The demo brand and its retailers (fixed ids: the judge stock fixture names rtl_north / rtl_pune).
if (!(await brands.getById(plan.brandId))) await brands.create({ brandId: plan.brandId, name: 'Demo Beauty Co' });
for (const [retailerId, name] of [
  ['rtl_north', 'North Retail'],
  ['rtl_pune', 'Pune Retail'],
] as const) {
  if (!(await retailers.get(plan.brandId, retailerId)))
    await retailers.create({ brandId: plan.brandId, retailerId, name });
}
console.log(`✔ Brand ${plan.brandId} and retailers`);

// 3. The same rebuild as "Reset demo".
const rebuilt = await container.demoReset.rebuild(plan.brandId, SEED);
console.log(
  `✔ Demo data: ${rebuilt.catalog.products} products, stock ${rebuilt.stock.status} (${rebuilt.stock.rowsValid} rows), ` +
    `${rebuilt.history.outcomes ?? 0} synthetic outcomes`,
);

// 4. Admins through the provisioning services (audited), then the shared demo password.
let brand = (await brands.getById(plan.brandId))!;
if (!brand.brandAdminUserId) {
  await platformAdmin.provisionBrandAdmin(platform, plan.brandId, plan.emails.brandAdmin);
  brand = (await brands.getById(plan.brandId))!;
}
await authUser(plan.emails.brandAdmin);
const brandPrincipal = {
  scope: 'BRAND',
  role: 'BRAND_ADMIN',
  userId: brand.brandAdminUserId!,
  email: plan.emails.brandAdmin,
  brandId: plan.brandId,
} as const;
for (const [storeId, email] of plan.emails.retailAdmins) {
  const store = await stores.get(plan.brandId, storeId);
  if (!store) refuse(`store ${storeId} was not imported`);
  if (!store.retailAdminUserId) await tenantAdmin.createRetailAdmin(brandPrincipal, storeId, email);
  await authUser(email);
}
console.log('✔ Brand Admin and Retail Admins (password = DEMO_PASSWORD)');

// The Cloud Run DEMO_LOGINS value (the password stays a placeholder here).
const logins = [
  [plan.emails.brandAdmin, 'BRAND_ADMIN', 'Brand Admin — Demo Beauty Co'],
  [plan.emails.retailAdmins[0]![1], 'RETAIL_ADMIN', 'Retail Admin — Bandra Store'],
  [plan.emails.retailAdmins[1]![1], 'RETAIL_ADMIN', 'Retail Admin — Andheri Store'],
  [plan.emails.platform, 'PLATFORM_ADMIN', 'Platform Admin'],
].map(([email, role, title]) => ({ email, password: '<DEMO_PASSWORD>', role, title, hint: '' }));
console.log('DEMO_LOGINS for Cloud Run (store it in Secret Manager with the real password):');
console.log(JSON.stringify(logins));
process.exit(0);
