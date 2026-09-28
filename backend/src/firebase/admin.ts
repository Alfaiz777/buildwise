import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { EmulatorHosts } from '../config/env.js';

export interface FirebaseServices {
  app: App;
  auth: Auth;
  db: Firestore;
}

/**
 * Initializes the Firebase Admin SDK. Firestore and Firebase Auth are direct SDK
 * dependencies in every profile — not ports — so the data model and the auth
 * chain are identical locally and in GCP.
 *
 * Credentials: Application Default Credentials — the Cloud Run service account
 * in gcp; none are needed against the emulators. No service-account key files.
 *
 * Emulators: the SDK reads FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST.
 * For the local profile they are defaulted here before the SDK initializes.
 */
export function initFirebase(projectId: string, emulators: EmulatorHosts | null = null): FirebaseServices {
  if (emulators) {
    process.env.FIRESTORE_EMULATOR_HOST ||= emulators.firestore;
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||= emulators.auth;
  }
  const app = getApps()[0] ?? initializeApp({ projectId });
  const db = getFirestore(app);
  if (!initialized.has(app)) {
    db.settings({ ignoreUndefinedProperties: true });
    initialized.add(app);
  }
  return { app, auth: getAuth(app), db };
}

const initialized = new WeakSet<App>();
