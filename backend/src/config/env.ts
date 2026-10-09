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
  QWIKSPOT_PROFILE: z.enum(PROFILES).default('local'),
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
  // Change 16 (UI-2): the shopper demo channel and media URLs.
  SHOPPER_SESSION_SECRET: z.string().optional(),
  PUBLIC_WEB_ORIGIN: z.string().trim().url().optional().or(z.literal('')),
  // L2-Shopify: the Shopify app (OAuth) — validated only when COMMERCE_PROVIDER=shopify.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SCOPES: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().optional(),
  PUBLIC_BACKEND_URL: z.string().optional(),
  FRONTEND_URL: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
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
  // L2-Shopify: one Shopify app (OAuth); each brand's store token is stored encrypted.
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'PUBLIC_BACKEND_URL',
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
  bigQueryDataset: string;
  gcsBucket: string;
}

/** The pinned Shopify Admin API version (latest stable when L2-Shopify was built; docs/06 §17.1). */
export const DEFAULT_SHOPIFY_API_VERSION = '2026-10';
export const DEFAULT_SHOPIFY_SCOPES = 'read_products,read_inventory,read_customers,read_orders';

/** The Shopify app (L2-Shopify). Secrets: never logged, never returned by an API. */
export interface ShopifyAppConfig {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  apiVersion: string;
  /** https origin Shopify calls back to (a dev tunnel locally). */
  publicBackendUrl: string;
  /** Where the browser lands after OAuth. */
  frontendUrl: string;
  /** AES-256-GCM key for stored tokens (32 bytes). */
  encryptionKey: Buffer;
}

/** Shopify's settings, validated together; the message names the variables, never their values. */
export function parseShopifyConfig(env: NodeJS.ProcessEnv): ShopifyAppConfig {
  const v = (name: string) => String(env[name] ?? '').trim();
  const bad: string[] = [];
  for (const name of ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET']) if (!v(name)) bad.push(name);
  const apiVersion = v('SHOPIFY_API_VERSION') || DEFAULT_SHOPIFY_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(apiVersion)) bad.push('SHOPIFY_API_VERSION');
  const scopes = (v('SHOPIFY_SCOPES') || DEFAULT_SHOPIFY_SCOPES).replace(/\s+/g, '');
  if (!/^[a-z_]+(,[a-z_]+)*$/.test(scopes)) bad.push('SHOPIFY_SCOPES');
  const url = (name: string, https: boolean) => {
    try {
      const u = new URL(v(name));
      if (https ? u.protocol !== 'https:' : !/^https?:$/.test(u.protocol)) throw new Error();
      return u.origin;
    } catch {
      bad.push(name);
      return '';
    }
  };
  const publicBackendUrl = url('PUBLIC_BACKEND_URL', true);
  const frontendUrl = v('FRONTEND_URL') ? url('FRONTEND_URL', false) : 'http://localhost:5173';
  let encryptionKey = Buffer.alloc(0);
  try {
    encryptionKey = Buffer.from(v('TOKEN_ENCRYPTION_KEY'), 'base64');
  } catch {
    /* reported below */
  }
  if (encryptionKey.length !== 32) bad.push('TOKEN_ENCRYPTION_KEY');
  if (bad.length > 0) throw new Error(`COMMERCE_PROVIDER=shopify needs valid settings: ${bad.join(', ')}`);
  return {
    apiKey: v('SHOPIFY_API_KEY'),
    apiSecret: v('SHOPIFY_API_SECRET'),
    scopes,
    apiVersion,
    publicBackendUrl,
    frontendUrl,
    encryptionKey,
  };
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
export const LOCAL_DEMO_PASSWORD = 'qwikspot-demo-1';
export const LOCAL_DEMO_LOGINS: DemoLogin[] = [
  {
    email: 'admin@demo-brand.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'BRAND_ADMIN',
    title: 'Brand Admin — Demo Beauty Co',
    hint: 'Start here: open the demo guide on Overview, try the shopper demo, then see Conversations and Insights.',
  },
  {
    email: 'retail-admin-north-1@qwikspot.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'RETAIL_ADMIN',
    title: 'Retail Admin — Bandra Store',
    hint: 'Confirm, prepare and complete customer holds for Bandra; try refusing one.',
  },
  {
    email: 'retail-admin-north-2@qwikspot.test',
    password: LOCAL_DEMO_PASSWORD,
    role: 'RETAIL_ADMIN',
    title: 'Retail Admin — Andheri Store',
    hint: "Andheri's queue: the demo story's hold lands here. Complete it with the customer's pickup code.",
  },
  {
    email: 'platform@qwikspot.test',
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
  /**
   * The shopper demo channel (Change 16): the HMAC secret that signs shopper session tokens.
   * null → a random per-process secret (local only; gcp with DEMO_MODE requires one).
   */
  shopper: { sessionSecret: string | null };
  /** The web app's public origin; relative media paths (product images) resolve against it. */
  publicWebOrigin: string;
  /** Present only in the gcp profile (validated as a whole). */
  gcp: GcpSettings | null;
  /** L2-Shopify: present only when COMMERCE_PROVIDER=shopify. */
  shopify: ShopifyAppConfig | null;
}

const LOCAL_PROJECT_ID = 'demo-qwikspot';

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
  const profile = e.QWIKSPOT_PROFILE;
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
      bigQueryDataset: v('BIGQUERY_DATASET'),
      gcsBucket: v('GCS_BUCKET'),
    };
  }

  // After the gcp contract check, so a deploy names every missing setting in one message.
  const shopify = adapters.commerce === 'shopify' ? parseShopifyConfig(env) : null;

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

  const sessionSecret = e.SHOPPER_SESSION_SECRET?.trim() || null;
  if (profile === 'gcp' && demoEnabled && (!sessionSecret || sessionSecret.length < 32)) {
    // The shopper demo runs on several Cloud Run instances: one shared secret, ≥ 32 characters.
    throw new Error('The gcp profile is missing required settings: SHOPPER_SESSION_SECRET');
  }
  const corsOrigins = e.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    profile,
    projectId,
    corsAllowedOrigins: corsOrigins,
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
    shopper: { sessionSecret },
    publicWebOrigin: (
      e.PUBLIC_WEB_ORIGIN || (profile === 'local' ? 'http://localhost:5173' : corsOrigins[0] || 'http://localhost:5173')
    ).replace(/\/$/, ''),
    gcp,
    shopify,
  };
}
