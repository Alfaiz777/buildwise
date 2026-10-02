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
  // M7 (Change 14, G3–G5): the judged demo. Never weakens authorization.
  DEMO_MODE: z.enum(['true', 'false', '']).optional(),
  DEMO_BRAND_IDS: z.string().optional(),
  DEMO_LOGINS: z.string().optional(),
  DEMO_HOLD_MINUTES: z.coerce.number().int().min(5).max(240).optional(),
  // Build identity for /api/health (set by Cloud Build).
  BUILD_VERSION: z.string().trim().max(40).optional(),
  BUILD_COMMIT: z.string().trim().max(64).optional(),
});

/**
 * The gcp configuration contract (Change 14, G7): every setting the live adapters will
 * need. Validated together at startup so a deploy fails fast with ONE message naming all
 * missing settings (never their values). Secrets arrive only through the environment
 * (Secret Manager → Cloud Run env).
 */
export const GCP_REQUIRED_SETTINGS = [
  'GOOGLE_CLOUD_PROJECT',
  'GCP_REGION',
  'VERTEX_MODEL',
  'VERTEX_LOCATION',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_ADMIN_TOKEN',
  'SHOPIFY_WEBHOOK_SECRET',
  'BIGQUERY_DATASET',
  'GCS_BUCKET',
  'DEMO_MODE',
  'CORS_ALLOWED_ORIGINS',
] as const;

export interface GcpSettings {
  region: string;
  firestoreDatabase: string;
  vertex: { model: string; location: string };
  whatsapp: { accessToken: string; phoneNumberId: string; appSecret: string; verifyToken: string };
  shopify: { shopDomain: string; adminToken: string; webhookSecret: string };
  bigQueryDataset: string;
  gcsBucket: string;
}

export interface DemoLogin {
  email: string;
  password: string;
  role: 'BRAND_ADMIN' | 'RETAIL_ADMIN' | 'PLATFORM_ADMIN';
  title: string;
  hint: string;
}

export interface DemoConfig {
  enabled: boolean;
  brandIds: string[];
  logins: DemoLogin[];
  holdMinutes: number;
}

const DemoLoginsSchema = z
  .array(
    z.object({
      email: z.string().email(),
      password: z.string().min(8),
      role: z.enum(['BRAND_ADMIN', 'RETAIL_ADMIN', 'PLATFORM_ADMIN']),
      title: z.string().min(1).max(60),
      hint: z.string().min(1).max(200),
    }),
  )
  .max(8);

/** The local demo users created by `seed:demo` (local profile only; deployed demos set DEMO_LOGINS). */
export const LOCAL_DEMO_PASSWORD = 'buildwise-demo-1';
export const LOCAL_DEMO_LOGINS: DemoLogin[] = [
  {
    email: 'admin@demo-brand.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'BRAND_ADMIN',
    title: 'Brand Admin — Demo Beauty Co',
    hint: 'Start here: open the demo guide, chat as a customer in the simulator, and see Outcomes & insights.',
  },
  {
    email: 'retail-admin-north-1@buildwise.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'RETAIL_ADMIN',
    title: 'Retail Admin — Bandra Store',
    hint: 'Confirm, prepare and complete customer holds for Bandra; try refusing one.',
  },
  {
    email: 'retail-admin-north-2@buildwise.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'RETAIL_ADMIN',
    title: 'Retail Admin — Andheri Store',
    hint: "Andheri's queue: the demo story's hold lands here. Complete it with the customer's pickup code.",
  },
  {
    email: 'platform@buildwise.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'PLATFORM_ADMIN',
    title: 'Platform Admin',
    hint: 'See every brand, its onboarding checklist and the platform audit log — never customer data.',
  },
];

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
  demo: DemoConfig;
  build: { version: string; commit: string | null };
  /** Present only in the gcp profile (validated as a whole). */
  gcp: GcpSettings | null;
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

  let gcp: GcpSettings | null = null;
  if (profile === 'gcp') {
    const missing = GCP_REQUIRED_SETTINGS.filter((name) => !String(env[name] ?? '').trim());
    if (missing.length > 0) {
      throw new Error(`The gcp profile is missing required settings: ${missing.join(', ')}`);
    }
    const v = (name: string) => String(env[name]).trim();
    gcp = {
      region: v('GCP_REGION'),
      firestoreDatabase: String(env.FIRESTORE_DATABASE ?? '').trim() || '(default)',
      vertex: { model: v('VERTEX_MODEL'), location: v('VERTEX_LOCATION') },
      whatsapp: {
        accessToken: v('WHATSAPP_ACCESS_TOKEN'),
        phoneNumberId: v('WHATSAPP_PHONE_NUMBER_ID'),
        appSecret: v('WHATSAPP_APP_SECRET'),
        verifyToken: v('WHATSAPP_VERIFY_TOKEN'),
      },
      shopify: {
        shopDomain: v('SHOPIFY_SHOP_DOMAIN'),
        adminToken: v('SHOPIFY_ADMIN_TOKEN'),
        webhookSecret: v('SHOPIFY_WEBHOOK_SECRET'),
      },
      bigQueryDataset: v('BIGQUERY_DATASET'),
      gcsBucket: v('GCS_BUCKET'),
    };
  }

  const projectId = e.GOOGLE_CLOUD_PROJECT || (profile === 'local' ? LOCAL_PROJECT_ID : '');
  if (!projectId) throw new Error('Invalid environment configuration: GOOGLE_CLOUD_PROJECT');

  const demoEnabled = e.DEMO_MODE === 'true';
  let logins: DemoLogin[] = [];
  if (demoEnabled) {
    if (e.DEMO_LOGINS?.trim()) {
      let raw: unknown;
      try {
        raw = JSON.parse(e.DEMO_LOGINS);
      } catch {
        throw new Error('Invalid environment configuration: DEMO_LOGINS');
      }
      const parsedLogins = DemoLoginsSchema.safeParse(raw);
      if (!parsedLogins.success) throw new Error('Invalid environment configuration: DEMO_LOGINS');
      logins = parsedLogins.data;
    } else if (profile === 'local') {
      logins = LOCAL_DEMO_LOGINS;
    }
  }

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
    demo: {
      enabled: demoEnabled,
      brandIds: (e.DEMO_BRAND_IDS ?? 'brd_demo')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      logins,
      holdMinutes: e.DEMO_HOLD_MINUTES ?? 20,
    },
    build: { version: e.BUILD_VERSION || 'dev', commit: e.BUILD_COMMIT || null },
    gcp,
  };
}
