/**
 * Frontend configuration from VITE_* build-time variables.
 *
 * Everything here ends up in the public JavaScript bundle, so it must never
 * contain secrets. The Firebase web config (API key, project ID, app ID) is a
 * public client identifier by design, not a credential: access control is
 * enforced by Firebase Auth, the backend and Firestore rules.
 *
 * Profiles mirror the backend (docs/03_TECH_ARCHITECTURE.md §2.2):
 *   local (default) — Firebase Auth emulator + demo project; needs no configuration.
 *   gcp             — real Firebase web config required; the emulator is refused.
 */
export type FrontendProfile = 'local' | 'gcp';

export interface AppConfig {
  profile: FrontendProfile;
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
  /** '' = same origin (/api via Vite proxy locally, Firebase Hosting rewrite when deployed). */
  apiBaseUrl: string;
  /** Firebase Auth emulator URL; local profile only. */
  authEmulatorUrl: string | null;
}

const LOCAL_DEFAULTS = {
  VITE_FIREBASE_API_KEY: 'demo-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-buildwise.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-buildwise',
  VITE_FIREBASE_APP_ID: '1:000000000000:web:demo',
  VITE_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099',
} as const;

type Env = Record<string, string | undefined>;

function value(env: Env, key: string, fallback: string | undefined): string {
  const v = env[key]?.trim() || fallback;
  if (!v) throw new Error(`Missing frontend configuration: ${key}`);
  return v;
}

export function readConfig(env: Env): AppConfig {
  const rawProfile = env.VITE_BUILDWISE_PROFILE?.trim() || 'local';
  if (rawProfile !== 'local' && rawProfile !== 'gcp') {
    throw new Error('Invalid frontend configuration: VITE_BUILDWISE_PROFILE');
  }
  const profile: FrontendProfile = rawProfile;
  const defaults: Partial<Record<keyof typeof LOCAL_DEFAULTS, string>> = profile === 'local' ? LOCAL_DEFAULTS : {};

  const authEmulatorUrl =
    env.VITE_FIREBASE_AUTH_EMULATOR_URL?.trim() || defaults.VITE_FIREBASE_AUTH_EMULATOR_URL || null;
  if (profile === 'gcp' && authEmulatorUrl) {
    throw new Error('The gcp profile refuses the Firebase Auth emulator (VITE_FIREBASE_AUTH_EMULATOR_URL)');
  }

  return {
    profile,
    firebase: {
      apiKey: value(env, 'VITE_FIREBASE_API_KEY', defaults.VITE_FIREBASE_API_KEY),
      authDomain: value(env, 'VITE_FIREBASE_AUTH_DOMAIN', defaults.VITE_FIREBASE_AUTH_DOMAIN),
      projectId: value(env, 'VITE_FIREBASE_PROJECT_ID', defaults.VITE_FIREBASE_PROJECT_ID),
      appId: value(env, 'VITE_FIREBASE_APP_ID', defaults.VITE_FIREBASE_APP_ID),
    },
    apiBaseUrl: (env.VITE_API_BASE_URL ?? '').trim().replace(/\/$/, ''),
    authEmulatorUrl,
  };
}
