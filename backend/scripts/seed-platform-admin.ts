/**
 * Bootstraps the FIRST PLATFORM_ADMIN (docs/07_SECURITY_SPEC.md §4.4).
 * This is the script's only job. Everything else is provisioned in the product:
 *   PLATFORM_ADMIN → brands + each brand’s single BRAND_ADMIN
 *   BRAND_ADMIN    → retailers + each retailer’s single RETAIL_ADMIN
 *
 * Usage (from the repo root):
 *   npm run seed:platform-admin -- --email ops@buildwise.test --password 'change-me-123'
 *
 * Local profile (default): writes to the Firebase emulators.
 * A real project additionally requires --confirm-project <projectId>.
 */
import { parseArgs } from 'node:util';
import { FieldValue } from 'firebase-admin/firestore';
import { loadConfig } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    'confirm-project': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`seed-platform-admin: ${message}`);
  process.exit(1);
}

const config = loadConfig();
const email = (values.email ?? fail('--email is required')).trim().toLowerCase();

if (!config.usingEmulators && values['confirm-project'] !== config.projectId) {
  fail(`not using emulators; pass --confirm-project ${config.projectId} to write to the real project`);
}

const { auth, db } = initFirebase(config.projectId, config.emulators);

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

const userRef = db.collection('users').doc(uid);
const existing = await userRef.get();
if (existing.exists && existing.get('role') !== 'PLATFORM_ADMIN') {
  fail(`users/${uid} already has role ${String(existing.get('role'))}; a user has exactly one role`);
}
if (!existing.exists) {
  await userRef.create({
    user_id: uid,
    role: 'PLATFORM_ADMIN',
    brand_id: null,
    retailer_id: null,
    email,
    status: 'ACTIVE',
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });
}
console.log(`PLATFORM_ADMIN ready: users/${uid} (${email})`);
process.exit(0);
