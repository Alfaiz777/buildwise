/**
 * LOCAL DEMO FIXTURE — Firebase emulators only. Synthetic data, never real PII
 * (docs/07_SECURITY_SPEC.md §19).
 *
 * MVP ownership model: a retailer may own many stores; each store belongs to one
 * retailer and has at most one RETAIL_ADMIN, who operates only that store. One
 * BRAND_ADMIN per brand. Two admins of stores of the SAME retailer prove that access
 * is store-level, not retailer-level:
 *
 *   brd_demo (Demo Beauty Co)
 *     └── rtl_north (North Retail)
 *          ├── st_north_1 Bandra Store   ── retail-admin-north-1@qwikspot.test
 *          ├── st_north_2 Andheri Store  ── retail-admin-north-2@qwikspot.test
 *          └── st_north_3 Powai Store    ── (no Retail Admin yet)
 *     └── rtl_pune (Pune Retail)
 *          └── st_pune_1 Koregaon Park   ── (no Retail Admin yet)
 *   brd_other (Other Brand Ltd) ── admin@other-brand.test (tenant-isolation checks)
 *     └── rtl_other ── st_other_1        ── (no Retail Admin yet)
 *
 *   platform@qwikspot.test  PLATFORM_ADMIN;  admin@demo-brand.test  BRAND_ADMIN of brd_demo
 *
 * M3: the catalogue comes from a real sync through the wired CommerceProvider (mock
 * locally), and stores + stock + SKU mappings come from running the real retail import on
 * backend/fixtures/retail/demo-retail.csv — the same code path as the Brand Console. The
 * demo CSV deliberately contains 2 invalid rows and 1 unknown SKU, so its import report
 * shows real row errors.
 *
 * M4: brand settings allow the local demo storefront (http://localhost:5173), enable human
 * handoff and use short follow-up delays (1–2 min) so the demo shows intent → delay →
 * proactive message. Demo shoppers (mock commerce customers 3002 opted in, 3003 not) are
 * linked when "Sign in as demo shopper" is used on the demo store (/shop).
 *
 * M6: 4 weeks of synthetic history (application/demoHistory.ts, every document marked
 * demo_history: true) and a 10-minute local attribution window.
 *
 * M5: reservations are enabled (max 2; M7: hold DEMO_HOLD_MINUTES, default 20), and
 * "Buy online" links to the demo storefront product page. MockAgentRuntime answers.
 *
 * M7: brd_demo is built by DemoResetService.rebuild() — the same code as "Reset demo" — and
 * imports fixtures/retail/demo-judge-retail.csv: the same stores and row errors, but shared-demo headroom (Serum 30 ml: Bandra 20, Andheri 25; Powai 0 and Serum
 * 50 ml none in Mumbai) and Mumbai stores open 00:00–23:59, so a judge in any timezone can
 * reserve (Change 14, G5). demo-retail.csv (10:00–21:00) stays the fixture for the tests.
 *
 * Every password: qwikspot-demo-1
 * Usage: npm run seed:demo   (re-runnable; resets the two fixture brands, upserts the users)
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { buildContainer } from '../src/composition/container.js';
import { loadConfig, LOCAL_DEMO_PASSWORD } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { silentLogger } from '../src/lib/logger.js';
import { demoBrandSettings } from '../src/application/demoSetup.js';

const PASSWORD = LOCAL_DEMO_PASSWORD;
const SEED_ACTOR = { type: 'SYSTEM' as const, id: 'seed-demo' };

const config = loadConfig();
if (!config.usingEmulators || !config.projectId.startsWith('demo-')) {
  console.error('seed-demo: refuses to run outside the Firebase emulators (demo-* project).');
  process.exit(1);
}
const { auth, db } = initFirebase(config.projectId, config.emulators);
const container = buildContainer(config, silentLogger);
const { commerceSync, retailImports } = container.appDeps.services;

const now = FieldValue.serverTimestamp();

async function brand(db: Firestore, brandId: string, name: string) {
  await db.doc(`brands/${brandId}`).set({
    brand_id: brandId,
    name,
    status: 'ACTIVE',
    // The same settings Reset demo writes (application/demoSetup.ts).
    settings: demoBrandSettings({
      current: {},
      brandName: name,
      holdMinutes: config.demo.holdMinutes,
      whatsappNumber: brandId === 'brd_demo' ? '910000000001' : '910000000002',
    }),
    brand_admin_user_id: null,
    created_at: now,
    updated_at: now,
  });
}

async function retailer(db: Firestore, brandId: string, retailerId: string, name: string) {
  await db.doc(`brands/${brandId}/retailers/${retailerId}`).set({
    retailer_id: retailerId,
    brand_id: brandId,
    name,
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
}

/** Runs the real retail import (create → store the file → process), as the console does. */
async function importRetailFile(brandId: string, fixture: string) {
  const path = fileURLToPath(new URL(`../fixtures/retail/${fixture}`, import.meta.url));
  const { record } = await retailImports.create(brandId, SEED_ACTOR, fixture);
  await container.providers.files.write(record.fileKey, await readFile(path), 'text/csv');
  const report = await retailImports.process(brandId, SEED_ACTOR, record.importId);
  const r = report.record;
  console.log(
    `  ${brandId}: import ${r.status} — ${r.rowsValid}/${r.rowsProcessed} rows valid, ` +
      `${r.mappingsCreated} SKUs mapped, ${r.mappingsFailed} not mapped, ${r.rowsInvalid} row errors`,
  );
  for (const e of report.rowErrors)
    console.log(`      line ${e.line}: ${e.code} (${e.sku ?? '-'} @ ${e.storeId ?? '-'})`);
}

async function user(
  auth: Auth,
  db: Firestore,
  email: string,
  role: string,
  scope: { brandId: string | null; retailerId: string | null; storeId: string | null },
): Promise<string> {
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(email)).uid;
    await auth.updateUser(uid, { password: PASSWORD });
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    uid = (await auth.createUser({ email, password: PASSWORD })).uid;
  }
  await db.doc(`users/${uid}`).set({
    user_id: uid,
    role,
    brand_id: scope.brandId,
    retailer_id: scope.retailerId,
    store_id: scope.storeId,
    email,
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
  console.log(`  ${role.padEnd(15)} ${email}`);
  return uid;
}

const none = { brandId: null, retailerId: null, storeId: null };

// Reset the fixture brands (emulator only) so documents from earlier fixture models never linger.
await db.recursiveDelete(db.doc('brands/brd_demo'));
await db.recursiveDelete(db.doc('brands/brd_other'));

await brand(db, 'brd_demo', 'Demo Beauty Co');
await brand(db, 'brd_other', 'Other Brand Ltd');
await retailer(db, 'brd_demo', 'rtl_north', 'North Retail');
await retailer(db, 'brd_demo', 'rtl_pune', 'Pune Retail');
await retailer(db, 'brd_other', 'rtl_other', 'Other Brand Retail');

// brd_demo: exactly what "Reset demo" rebuilds — sync, judge stock fixture, synthetic history.
console.log('brd_demo (same steps as Reset demo):');
const demo = await container.demoReset.rebuild('brd_demo', SEED_ACTOR);
console.log(`  catalogue: ${demo.catalog.products} products, ${demo.catalog.variants} variants (mock commerce)`);
console.log(
  `  stock: import ${demo.stock.status}, ${demo.stock.rowsValid} rows valid, ${demo.stock.rowsInvalid} row errors`,
);
console.log(
  `  synthetic history (demo_history: true): ${Object.entries(demo.history)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);

console.log('brd_other (tenant-isolation checks):');
const other = await commerceSync.sync('brd_other', SEED_ACTOR);
console.log(`  catalogue: ${other.productCount} products, ${other.variantCount} variants`);
await importRetailFile('brd_other', 'other-brand-retail.csv');

console.log(`Demo users (password for every user: ${PASSWORD}):`);
await user(auth, db, 'platform@qwikspot.test', 'PLATFORM_ADMIN', none);
const demoAdmin = await user(auth, db, 'admin@demo-brand.test', 'BRAND_ADMIN', { ...none, brandId: 'brd_demo' });
const north1 = await user(auth, db, 'retail-admin-north-1@qwikspot.test', 'RETAIL_ADMIN', {
  brandId: 'brd_demo',
  retailerId: 'rtl_north',
  storeId: 'st_north_1',
});
const north2 = await user(auth, db, 'retail-admin-north-2@qwikspot.test', 'RETAIL_ADMIN', {
  brandId: 'brd_demo',
  retailerId: 'rtl_north',
  storeId: 'st_north_2',
});
const otherAdmin = await user(auth, db, 'admin@other-brand.test', 'BRAND_ADMIN', { ...none, brandId: 'brd_other' });

// Record each scope's single admin (what in-product provisioning does via the admin slot).
await db.doc('brands/brd_demo').update({ brand_admin_user_id: demoAdmin });
await db.doc('brands/brd_other').update({ brand_admin_user_id: otherAdmin });
await db.doc('brands/brd_demo/stores/st_north_1').update({ retail_admin_user_id: north1 });
await db.doc('brands/brd_demo/stores/st_north_2').update({ retail_admin_user_id: north2 });
process.exit(0);
