/**
 * Provisions a brand and a Buildwise user (users/{uid}).
 *
 * MVP user provisioning is a seed/admin script (docs/00_M0_SPECIFICATION_FREEZE.md §11.7).
 * There is no self-signup: a Firebase login without a users/{uid} document gets 403.
 *
 * Usage (from the repo root):
 *   npm run seed:user -- --email admin@brand.test --password 'change-me-123' \
 *     --brand-id brand_demo --brand-name "Demo Brand" --role BRAND_ADMIN
 *   npm run seed:user -- --email staff@brand.test --role RETAIL_STAFF \
 *     --brand-id brand_demo --store-ids store_A,store_B
 *
 * Against the emulators (FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST set)
 * it runs freely. Against a real project it requires --confirm-project <projectId>.
 * Without --password the Firebase Auth user must already exist.
 */
import { parseArgs } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import { ROLES, isRetailRole, type Role } from '../src/auth/types.js';
import { loadConfig } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    'brand-id': { type: 'string' },
    'brand-name': { type: 'string' },
    role: { type: 'string' },
    'store-ids': { type: 'string', default: '' },
    'confirm-project': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`seed-user: ${message}`);
  process.exit(1);
}

const config = loadConfig();
const email = values.email ?? fail('--email is required');
const brandId = values['brand-id'] ?? fail('--brand-id is required');
const roleArg = values.role ?? fail('--role is required');
if (!(ROLES as readonly string[]).includes(roleArg)) fail(`--role must be one of ${ROLES.join(', ')}`);
const role = roleArg as Role;
const storeIds = values['store-ids'].split(',').map((s) => s.trim()).filter(Boolean);
if (isRetailRole(role) && storeIds.length === 0) fail('RETAIL_* roles require --store-ids');
if (!isRetailRole(role) && storeIds.length > 0) fail('--store-ids only applies to RETAIL_* roles');

if (!config.usingEmulators && values['confirm-project'] !== config.projectId) {
  fail(`not using emulators; pass --confirm-project ${config.projectId} to write to the real project`);
}

const { auth, db } = initFirebase(config.projectId);

let uid: string;
try {
  uid = (await auth.getUserByEmail(email)).uid;
  console.log(`Auth user exists: ${uid}`);
} catch (err) {
  if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  if (!values.password) fail(`no Auth user for ${email}; pass --password to create one`);
  uid = (await auth.createUser({ email, password: values.password })).uid;
  console.log(`Auth user created: ${uid}`);
}

const brandRef = db.collection('brands').doc(brandId);
const brandSnap = await brandRef.get();
if (!brandSnap.exists) {
  await brandRef.set({
    brand_id: brandId,
    name: values['brand-name'] ?? brandId,
    status: 'ACTIVE',
    settings: {},
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });
  console.log(`Brand created: brands/${brandId}`);
}

const userRef = db.collection('users').doc(uid);
const existing = await userRef.get();
if (existing.exists && existing.get('brand_id') !== brandId) {
  fail(`users/${uid} already belongs to brand ${String(existing.get('brand_id'))}; one user = one brand in the MVP`);
}
await userRef.set(
  {
    user_id: uid,
    brand_id: brandId,
    role,
    store_ids: storeIds,
    email,
    status: 'ACTIVE',
    updated_at: FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : { created_at: FieldValue.serverTimestamp() }),
  },
  { merge: true },
);
console.log(`User provisioned: users/${uid} → ${brandId} / ${role}`);
process.exit(0);
