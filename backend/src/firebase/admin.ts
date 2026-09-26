import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export interface FirebaseServices {
  app: App;
  auth: Auth;
  db: Firestore;
}

/**
 * Initializes the Firebase Admin SDK.
 *
 * Credentials: Application Default Credentials — the Cloud Run service account
 * in production, `gcloud auth application-default login` or no credentials at
 * all against the emulators locally. No service-account key files are used.
 *
 * Emulators: when FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set
 * the SDK talks to the local emulators automatically.
 */
export function initFirebase(projectId: string): FirebaseServices {
  const app = getApps()[0] ?? initializeApp({ projectId });
  const db = getFirestore(app);
  if (!initialized.has(app)) {
    db.settings({ ignoreUndefinedProperties: true });
    initialized.add(app);
  }
  return { app, auth: getAuth(app), db };
}

const initialized = new WeakSet<App>();
