/**
 * Frontend configuration from VITE_* build-time variables.
 *
 * Everything here ends up in the public JavaScript bundle, so it must never
 * contain secrets. The Firebase web config (API key, project ID, app ID) is a
 * public client identifier by design, not a credential: access control is
 * enforced by Firebase Auth, the backend and Firestore rules.
 */
export interface AppConfig {
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
  /** '' = same origin (/api via Vite proxy locally, Firebase Hosting rewrite when deployed). */
  apiBaseUrl: string;
  /** e.g. http://127.0.0.1:9099 — set only for local development against the emulator. */
  authEmulatorUrl: string | null;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing frontend configuration: ${key}`);
  return value;
}

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    firebase: {
      apiKey: required(env, 'VITE_FIREBASE_API_KEY'),
      authDomain: required(env, 'VITE_FIREBASE_AUTH_DOMAIN'),
      projectId: required(env, 'VITE_FIREBASE_PROJECT_ID'),
      appId: required(env, 'VITE_FIREBASE_APP_ID'),
    },
    apiBaseUrl: (env.VITE_API_BASE_URL ?? '').trim().replace(/\/$/, ''),
    authEmulatorUrl: env.VITE_FIREBASE_AUTH_EMULATOR_URL?.trim() || null,
  };
}
