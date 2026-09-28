import { z } from 'zod';
import {
  DEFAULT_EMULATOR_HOSTS,
  PROFILE_DEFAULTS,
  PROFILES,
  profileViolations,
  type AdapterSelection,
  type Profile,
} from './profile.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.enum(values).optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BUILDWISE_PROFILE: z.enum(PROFILES).default('local'),
  GOOGLE_CLOUD_PROJECT: z.string().trim().optional(),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOCAL_DATA_DIR: z.string().trim().min(1).default('.data'),
  // Adapter selectors; empty = the profile default.
  COMMERCE_PROVIDER: optionalEnum(['mock', 'shopify'] as const),
  MESSAGING_CHANNELS: z.string().optional(),
  AGENT_RUNTIME: optionalEnum(['mock', 'adk_gemini'] as const),
  FILE_STORAGE: optionalEnum(['local', 'gcs'] as const),
  EVENT_SINK: optionalEnum(['local', 'bigquery'] as const),
  // Read by the Firebase Admin SDK.
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
});

export interface EmulatorHosts {
  firestore: string;
  auth: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  profile: Profile;
  projectId: string;
  corsAllowedOrigins: string[];
  logLevel: LogLevel;
  localDataDir: string;
  adapters: AdapterSelection;
  /** Set when Firebase must talk to the emulators (always, by default, in the local profile). */
  emulators: EmulatorHosts | null;
  usingEmulators: boolean;
}

const LOCAL_PROJECT_ID = 'demo-buildwise';

function parseChannels(raw: string | undefined, fallback: AdapterSelection['messagingChannels']) {
  if (!raw?.trim()) return fallback;
  const channels = [...new Set(raw.split(',').map((c) => c.trim().toLowerCase()))].filter(Boolean);
  if (channels.length === 0 || channels.some((c) => c !== 'simulator' && c !== 'whatsapp')) {
    throw new Error('Invalid environment configuration: MESSAGING_CHANNELS');
  }
  return channels as AdapterSelection['messagingChannels'];
}

/**
 * Validates environment configuration at startup and resolves the execution profile.
 * Error messages name the invalid variables but never echo their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  const e = parsed.data;
  const profile = e.BUILDWISE_PROFILE;
  const defaults = PROFILE_DEFAULTS[profile];

  const adapters: AdapterSelection = {
    commerce: e.COMMERCE_PROVIDER ?? defaults.commerce,
    messagingChannels: parseChannels(e.MESSAGING_CHANNELS, defaults.messagingChannels),
    agentRuntime: e.AGENT_RUNTIME ?? defaults.agentRuntime,
    fileStorage: e.FILE_STORAGE ?? defaults.fileStorage,
    eventSink: e.EVENT_SINK ?? defaults.eventSink,
  };

  const explicitEmulators = Boolean(e.FIRESTORE_EMULATOR_HOST || e.FIREBASE_AUTH_EMULATOR_HOST);
  const emulators: EmulatorHosts | null =
    profile === 'local' || explicitEmulators
      ? {
          firestore: e.FIRESTORE_EMULATOR_HOST || DEFAULT_EMULATOR_HOSTS.firestore,
          auth: e.FIREBASE_AUTH_EMULATOR_HOST || DEFAULT_EMULATOR_HOSTS.auth,
        }
      : null;

  if (e.NODE_ENV === 'production' && emulators) {
    throw new Error('Emulator hosts must not be used when NODE_ENV=production');
  }

  const violations = profileViolations(profile, adapters, emulators !== null);
  if (violations.length > 0) {
    throw new Error(`The gcp profile refuses local/mock infrastructure: ${violations.join(', ')}`);
  }

  const projectId = e.GOOGLE_CLOUD_PROJECT || (profile === 'local' ? LOCAL_PROJECT_ID : '');
  if (!projectId) throw new Error('Invalid environment configuration: GOOGLE_CLOUD_PROJECT');

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    profile,
    projectId,
    corsAllowedOrigins: e.CORS_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    localDataDir: e.LOCAL_DATA_DIR,
    adapters,
    emulators,
    usingEmulators: emulators !== null,
  };
}
