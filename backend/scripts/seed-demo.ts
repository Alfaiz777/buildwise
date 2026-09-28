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
 *          ├── st_north_1 Bandra Store   ── retail-admin-north-1@buildwise.test
 *          ├── st_north_2 Andheri Store  ── retail-admin-north-2@buildwise.test
 *          └── st_north_3 Powai Store    ── (no Retail Admin yet)
 *     └── rtl_pune (Pune Retail)
 *          └── st_pune_1 Koregaon Park   ── (no Retail Admin yet)
 *   brd_other (Other Brand Ltd) ── admin@other-brand.test (tenant-isolation checks)
 *     └── rtl_other ── st_other_1        ── (no Retail Admin yet)
 *
 *   platform@buildwise.test  PLATFORM_ADMIN;  admin@demo-brand.test  BRAND_ADMIN of brd_demo
 *
 * Stores without a Retail Admin show the Brand Console's per-store "Provision Retail Admin".
 * Customers are not console users; they arrive through the customer channel (M6).
 *
 * Every password: buildwise-demo-1
 *
 * Stores and their retailer are seeded directly only because retail ingestion arrives in M4.
 * Usage: npm run seed:demo   (re-runnable; resets the two fixture brands, upserts the users)
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { loadConfig } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';

const PASSWORD = 'buildwise-demo-1';

const config = loadConfig();
if (!config.usingEmulators || !config.projectId.startsWith('demo-')) {
  console.error('seed-demo: refuses to run outside the Firebase emulators (demo-* project).');
  process.exit(1);
}
const { auth, db } = initFirebase(config.projectId, config.emulators);

const HOURS = {
  timezone: 'Asia/Kolkata',
  monday: '10:00-21:00',
  tuesday: '10:00-21:00',
  wednesday: '10:00-21:00',
  thursday: '10:00-21:00',
  friday: '10:00-21:00',
  saturday: '10:00-22:00',
  sunday: '11:00-20:00',
};

const now = FieldValue.serverTimestamp();

async function brand(db: Firestore, brandId: string, name: string) {
  await db.doc(`brands/${brandId}`).set({
    brand_id: brandId,
    name,
    status: 'ACTIVE',
    settings: {},
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

/** A store of one retailer (a retailer may own many stores). */
async function store(
  db: Firestore,
  brandId: string,
  retailerId: string,
  store: { storeId: string; storeName: string; city: string; latitude: number; longitude: number },
) {
  await db.doc(`brands/${brandId}/stores/${store.storeId}`).set({
    store_id: store.storeId,
    brand_id: brandId,
    retailer_id: retailerId,
    store_name: store.storeName,
    city: store.city,
    address: `${store.storeName}, ${store.city}`,
    latitude: store.latitude,
    longitude: store.longitude,
    store_hours: HOURS,
    store_status: 'ACTIVE',
    reservation_available: true,
    pickup_available: true,
    retail_admin_user_id: null,
    updated_at: now,
  });
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
await store(db, 'brd_demo', 'rtl_north', {
  storeId: 'st_north_1',
  storeName: 'Bandra Store',
  city: 'Mumbai',
  latitude: 19.06,
  longitude: 72.83,
});
await store(db, 'brd_demo', 'rtl_north', {
  storeId: 'st_north_2',
  storeName: 'Andheri Store',
  city: 'Mumbai',
  latitude: 19.12,
  longitude: 72.85,
});
await store(db, 'brd_demo', 'rtl_north', {
  storeId: 'st_north_3',
  storeName: 'Powai Store',
  city: 'Mumbai',
  latitude: 19.12,
  longitude: 72.91,
});
await retailer(db, 'brd_demo', 'rtl_pune', 'Pune Retail');
await store(db, 'brd_demo', 'rtl_pune', {
  storeId: 'st_pune_1',
  storeName: 'Koregaon Park Store',
  city: 'Pune',
  latitude: 18.54,
  longitude: 73.89,
});
await retailer(db, 'brd_other', 'rtl_other', 'Other Brand Retail');
await store(db, 'brd_other', 'rtl_other', {
  storeId: 'st_other_1',
  storeName: 'Other Brand Store',
  city: 'Delhi',
  latitude: 28.63,
  longitude: 77.22,
});

console.log(`Demo fixture ready (password for every user: ${PASSWORD}):`);
await user(auth, db, 'platform@buildwise.test', 'PLATFORM_ADMIN', none);
const demoAdmin = await user(auth, db, 'admin@demo-brand.test', 'BRAND_ADMIN', { ...none, brandId: 'brd_demo' });
const north1 = await user(auth, db, 'retail-admin-north-1@buildwise.test', 'RETAIL_ADMIN', {
  brandId: 'brd_demo',
  retailerId: 'rtl_north',
  storeId: 'st_north_1',
});
const north2 = await user(auth, db, 'retail-admin-north-2@buildwise.test', 'RETAIL_ADMIN', {
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
