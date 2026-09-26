import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import type { AppConfig } from '../config';

/**
 * Firebase in the browser is used for Authentication ONLY.
 * The browser never imports firebase/firestore: all data goes through the
 * Cloud Run API (docs/03_TECH_ARCHITECTURE.md §7).
 */
export function initFirebaseAuth(config: AppConfig): Auth {
  const app = initializeApp(config.firebase);
  const auth = getAuth(app);
  if (config.authEmulatorUrl) {
    connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
  }
  return auth;
}
