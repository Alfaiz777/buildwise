import { initializeApp } from 'firebase/app';
import { browserSessionPersistence, connectAuthEmulator, initializeAuth, type Auth } from 'firebase/auth';
import type { AppConfig } from '../config';

/**
 * Firebase in the browser is used for Authentication ONLY.
 * The browser never imports firebase/firestore: all data goes through the
 * Cloud Run API (docs/03_TECH_ARCHITECTURE.md §7).
 *
 * M7 (Change 14, G3): the session lives in this tab only (sessionStorage). Each tab can be
 * signed in as a different console user — the 4-tab demo — and closing the tab signs out.
 */
export function initFirebaseAuth(config: AppConfig): Auth {
  const app = initializeApp(config.firebase);
  const auth = initializeAuth(app, { persistence: browserSessionPersistence });
  if (config.authEmulatorUrl) {
    connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
  }
  return auth;
}
