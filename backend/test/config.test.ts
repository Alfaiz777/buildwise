import { describe, expect, it } from 'vitest';
import { loadConfig, LOCAL_DEMO_LOGINS } from '../src/config/env.js';

/** Fake Shopify app settings (L2-Shopify) — never real secrets; the key is 32 bytes of "x". */
export const SHOPIFY_FAKE = {
  SHOPIFY_API_KEY: 'fake-shopify-key',
  SHOPIFY_API_SECRET: 'fake-shopify-secret',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 'x').toString('base64'),
  PUBLIC_BACKEND_URL: 'https://api.example.test',
};

/** Fake values for every gcp setting (Change 14, G7) — never real secrets. */
export const GCP_REQUIRED_FAKE = {
  GCP_REGION: 'asia-south1',
  VERTEX_MODEL: 'gemini-test-model',
  VERTEX_LOCATION: 'asia-south1',
  WHATSAPP_ACCESS_TOKEN: 'fake-wa-token',
  WHATSAPP_PHONE_NUMBER_ID: '000000000000',
  WHATSAPP_APP_SECRET: 'fake-app-secret',
  WHATSAPP_VERIFY_TOKEN: 'fake-verify',
  ...SHOPIFY_FAKE,
  BIGQUERY_DATASET: 'qwikspot_events',
  GCS_BUCKET: 'qwikspot-uploads-test',
  DEMO_MODE: 'false',
  CORS_ALLOWED_ORIGINS: 'https://qwikspot.example.web.app',
  SCHEDULER_SERVICE_ACCOUNT: 'qwikspot-scheduler@qwikspot-prod.iam.gserviceaccount.com',
};

const GCP_REAL = {
  QWIKSPOT_PROFILE: 'gcp',
  GOOGLE_CLOUD_PROJECT: 'qwikspot-prod',
  NODE_ENV: 'production',
  ...GCP_REQUIRED_FAKE,
} as const;

describe('loadConfig — local profile (default)', () => {
  it('needs no configuration at all and never requires Google Cloud', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 8080,
      profile: 'local',
      projectId: 'demo-qwikspot',
      localDataDir: '.data',
      usingEmulators: true,
      emulators: { firestore: '127.0.0.1:8085', auth: '127.0.0.1:9099' },
      adapters: {
        commerce: 'mock',
        messagingChannels: ['simulator'],
        agentRuntime: 'mock',
        fileStorage: 'local',
        eventSink: 'local',
      },
    });
  });

  it('respects explicit emulator hosts and empty selector values', () => {
    const config = loadConfig({ FIRESTORE_EMULATOR_HOST: 'localhost:9000', COMMERCE_PROVIDER: '', AGENT_RUNTIME: '' });
    expect(config.emulators).toEqual({ firestore: 'localhost:9000', auth: '127.0.0.1:9099' });
    expect(config.adapters.commerce).toBe('mock');
  });

  it('allows per-adapter overrides for isolated spikes', () => {
    const config = loadConfig({
      ...SHOPIFY_FAKE,
      COMMERCE_PROVIDER: 'shopify',
      MESSAGING_CHANNELS: 'simulator,whatsapp',
    });
    expect(config.adapters.commerce).toBe('shopify');
    expect(config.adapters.messagingChannels).toEqual(['simulator', 'whatsapp']);
  });

  it('names invalid variables without echoing their values', () => {
    try {
      loadConfig({ PORT: 'super-secret-value' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('PORT');
      expect((err as Error).message).not.toContain('super-secret-value');
    }
    expect(() => loadConfig({ MESSAGING_CHANNELS: 'sms' })).toThrow(/MESSAGING_CHANNELS/);
    expect(() => loadConfig({ QWIKSPOT_PROFILE: 'staging' })).toThrow(/QWIKSPOT_PROFILE/);
  });

  it('parses the CORS allowlist', () => {
    const config = loadConfig({ CORS_ALLOWED_ORIGINS: ' https://a.test ,https://b.test,, ' });
    expect(config.corsAllowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('refuses emulators when NODE_ENV=production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Emulator/);
  });
});

describe('loadConfig — gcp profile and startup guard (docs/07 §19)', () => {
  it('defaults to the real adapters, with the simulator kept as the fallback channel', () => {
    const config = loadConfig(GCP_REAL);
    expect(config).toMatchObject({
      profile: 'gcp',
      projectId: 'qwikspot-prod',
      usingEmulators: false,
      emulators: null,
      adapters: {
        commerce: 'shopify',
        messagingChannels: ['whatsapp', 'simulator'],
        agentRuntime: 'adk_gemini',
        fileStorage: 'gcs',
        eventSink: 'bigquery',
      },
    });
  });

  it('requires GOOGLE_CLOUD_PROJECT', () => {
    expect(() => loadConfig({ QWIKSPOT_PROFILE: 'gcp' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it.each([
    ['COMMERCE_PROVIDER', 'mock'],
    ['AGENT_RUNTIME', 'mock'],
    ['FILE_STORAGE', 'local'],
    ['EVENT_SINK', 'local'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => loadConfig({ ...GCP_REAL, [key]: value })).toThrow(new RegExp(`gcp profile refuses.*${key}=${value}`));
  });

  it('refuses the Firebase emulators', () => {
    expect(() =>
      loadConfig({ ...GCP_REAL, NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: 'localhost:8085' }),
    ).toThrow(/gcp profile refuses.*emulator/);
  });

  it('allows the simulator channel (approved fallback), alone or with WhatsApp', () => {
    expect(loadConfig({ ...GCP_REAL, MESSAGING_CHANNELS: 'simulator' }).adapters.messagingChannels).toEqual([
      'simulator',
    ]);
    expect(loadConfig({ ...GCP_REAL, MESSAGING_CHANNELS: 'whatsapp,simulator' }).adapters.messagingChannels).toEqual([
      'whatsapp',
      'simulator',
    ]);
  });

  it('validates the whole gcp configuration contract at once, naming missing settings but never values', () => {
    const { WHATSAPP_APP_SECRET: _a, SHOPIFY_API_SECRET: _b, ...rest } = GCP_REAL;
    let message = '';
    try {
      loadConfig({ ...rest, VERTEX_MODEL: '  ' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      'The gcp profile is missing required settings: VERTEX_MODEL, WHATSAPP_APP_SECRET, SHOPIFY_API_SECRET',
    );
    expect(message).not.toMatch(/fake-|asia-south1/);
    expect(loadConfig(GCP_REAL).gcp).toMatchObject({
      region: 'asia-south1',
      firestoreDatabase: '(default)',
      vertex: { model: 'gemini-test-model' },
      gcsBucket: 'qwikspot-uploads-test',
    });
    expect(loadConfig(GCP_REAL).shopify).toMatchObject({ apiKey: SHOPIFY_FAKE.SHOPIFY_API_KEY, apiVersion: '2026-10' });
    expect(loadConfig({}).gcp).toBeNull(); // the local profile needs none of it
  });

  it('DEMO_MODE: off by default; local demo logins only when on; deployed logins only from DEMO_LOGINS', () => {
    expect(loadConfig({}).demo).toEqual({ enabled: false, brandIds: ['brd_demo'], logins: [], holdMinutes: 20 });
    expect(loadConfig({ DEMO_MODE: 'true' }).demo.logins.map((l) => l.role)).toEqual([
      'BRAND_ADMIN',
      'RETAIL_ADMIN',
      'RETAIL_ADMIN',
      'PLATFORM_ADMIN',
    ]);
    expect(loadConfig({ ...GCP_REAL, DEMO_MODE: 'true', SHOPPER_SESSION_SECRET: 'x'.repeat(32) }).demo).toMatchObject({
      enabled: true,
      logins: [],
    });
    // Change 16: the hosted shopper demo needs one shared session secret (≥ 32 characters).
    expect(() => loadConfig({ ...GCP_REAL, DEMO_MODE: 'true' })).toThrow(
      'The gcp profile is missing required settings: SHOPPER_SESSION_SECRET',
    );
    expect(() => loadConfig({ ...GCP_REAL, DEMO_MODE: 'true', SHOPPER_SESSION_SECRET: 'short' })).toThrow(
      /SHOPPER_SESSION_SECRET/,
    );
    expect(loadConfig({ ...GCP_REAL }).shopper.sessionSecret).toBeNull(); // DEMO_MODE off: not needed
    expect(loadConfig({}).publicWebOrigin).toBe('http://localhost:5173');
    const logins = JSON.stringify([
      {
        email: 'judge@example.test',
        password: 'judge-pass-1',
        role: 'BRAND_ADMIN',
        title: 'Brand',
        hint: 'Start here.',
      },
    ]);
    expect(
      loadConfig({ ...GCP_REAL, DEMO_MODE: 'true', DEMO_LOGINS: logins, SHOPPER_SESSION_SECRET: 'x'.repeat(32) }).demo
        .logins,
    ).toHaveLength(1);
    expect(() => loadConfig({ DEMO_MODE: 'true', DEMO_LOGINS: '{not json' })).toThrow(
      'Invalid environment configuration: DEMO_LOGINS',
    );
    expect(loadConfig({ DEMO_BRAND_IDS: 'brd_a, brd_b', DEMO_HOLD_MINUTES: '15' }).demo).toMatchObject({
      brandIds: ['brd_a', 'brd_b'],
      holdMinutes: 15,
    });
  });

  it('lists every violation at once', () => {
    expect(() => loadConfig({ ...GCP_REAL, COMMERCE_PROVIDER: 'mock', AGENT_RUNTIME: 'mock' })).toThrow(
      /COMMERCE_PROVIDER=mock, AGENT_RUNTIME=mock/,
    );
  });
});

describe('local demo login hints (judge-test fixes)', () => {
  it('point at the surfaces that exist: the shopper demo, never the removed Brand Console simulator', () => {
    for (const login of LOCAL_DEMO_LOGINS) expect(login.hint).not.toMatch(/simulator/i);
    expect(LOCAL_DEMO_LOGINS.find((l) => l.role === 'BRAND_ADMIN')!.hint).toBe(
      'Start here: open the demo guide on Overview, try the shopper demo, then see Conversations and Insights.',
    );
  });
});

describe('Shopify app settings (L2-Shopify)', () => {
  const SHOPIFY = { ...SHOPIFY_FAKE, COMMERCE_PROVIDER: 'shopify' };

  it('are validated only with COMMERCE_PROVIDER=shopify; mock needs none of them', () => {
    expect(loadConfig({}).shopify).toBeNull();
    expect(loadConfig({ COMMERCE_PROVIDER: 'mock', SHOPIFY_API_KEY: '' }).shopify).toBeNull();
    const config = loadConfig(SHOPIFY);
    expect(config.shopify).toMatchObject({
      apiKey: SHOPIFY_FAKE.SHOPIFY_API_KEY,
      scopes: 'read_products,read_inventory,read_customers,read_orders',
      apiVersion: '2026-10',
      publicBackendUrl: 'https://api.example.test',
      frontendUrl: 'http://localhost:5173',
    });
    expect(config.shopify!.encryptionKey).toHaveLength(32);
  });

  it('name every missing or invalid setting at once, never a value', () => {
    let message = '';
    try {
      loadConfig({
        COMMERCE_PROVIDER: 'shopify',
        SHOPIFY_API_SECRET: 'super-secret-value',
        PUBLIC_BACKEND_URL: 'http://not-https.example',
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 'k').toString('base64'),
        SHOPIFY_API_VERSION: '2026-11',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      'COMMERCE_PROVIDER=shopify needs valid settings: SHOPIFY_API_KEY, SHOPIFY_API_VERSION, PUBLIC_BACKEND_URL, TOKEN_ENCRYPTION_KEY',
    );
    expect(message).not.toMatch(/super-secret|not-https|a2tr/);
  });
});

describe('L1 staged rollout (GCP_STAGED_ROLLOUT) and conditional gcp settings', () => {
  /** A staged L1 deployment: no WhatsApp, no Vertex settings at all. */
  const { VERTEX_MODEL: _vm, VERTEX_LOCATION: _vl, ...withoutVertex } = GCP_REAL;
  const {
    WHATSAPP_ACCESS_TOKEN: _a,
    WHATSAPP_PHONE_NUMBER_ID: _b,
    WHATSAPP_APP_SECRET: _c,
    WHATSAPP_VERIFY_TOKEN: _d,
    ...STAGED_BASE
  } = withoutVertex;
  const STAGED = {
    ...STAGED_BASE,
    GCP_STAGED_ROLLOUT: 'true',
    AGENT_RUNTIME: 'mock',
    MESSAGING_CHANNELS: 'simulator',
  };

  it('staged off: the mock agent is refused as before', () => {
    expect(() => loadConfig({ ...STAGED, GCP_STAGED_ROLLOUT: 'false' })).toThrow(
      /gcp profile refuses.*AGENT_RUNTIME=mock/,
    );
    expect(() => loadConfig({ ...STAGED, GCP_STAGED_ROLLOUT: '' })).toThrow(/AGENT_RUNTIME=mock/);
  });

  it('staged on: boots with the mock agent and the simulator only — no WhatsApp or Vertex settings needed — and says so', () => {
    const config = loadConfig(STAGED);
    expect(config.adapters).toMatchObject({
      agentRuntime: 'mock',
      messagingChannels: ['simulator'],
      commerce: 'shopify',
      fileStorage: 'gcs',
      eventSink: 'bigquery',
    });
    expect(config.staged).toEqual(['AGENT_RUNTIME=mock', 'MESSAGING_CHANNELS=simulator']);
    expect(config.gcp).toMatchObject({ vertex: null, whatsapp: null, gcsBucket: 'qwikspot-uploads-test' });
  });

  it.each([
    ['COMMERCE_PROVIDER', 'mock'],
    ['FILE_STORAGE', 'local'],
    ['EVENT_SINK', 'local'],
  ])('staged on still refuses %s=%s', (key, value) => {
    expect(() => loadConfig({ ...STAGED, [key]: value })).toThrow(new RegExp(`gcp profile refuses.*${key}=${value}`));
  });

  it('staged on still refuses the Firebase emulators', () => {
    expect(() => loadConfig({ ...STAGED, NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: 'localhost:8085' })).toThrow(
      /gcp profile refuses.*emulator/,
    );
  });

  it('staged only applies to gcp: the local profile ignores it and reports nothing staged', () => {
    expect(loadConfig({ GCP_STAGED_ROLLOUT: 'true' }).staged).toEqual([]);
    expect(loadConfig(GCP_REAL).staged).toEqual([]);
  });

  it('settings follow the selected adapters: WhatsApp only with the whatsapp channel, Vertex only with Gemini', () => {
    const message = (env: Record<string, string>) => {
      try {
        loadConfig(env);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(message({ ...STAGED, MESSAGING_CHANNELS: 'whatsapp,simulator' })).toBe(
      'The gcp profile is missing required settings: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN',
    );
    expect(message({ ...STAGED, AGENT_RUNTIME: 'adk_gemini' })).toBe(
      'The gcp profile is missing required settings: VERTEX_MODEL, VERTEX_LOCATION',
    );
    // With both missing and something else too: still one message, in contract order.
    const { GCS_BUCKET: _g, ...noBucket } = STAGED_BASE;
    expect(message({ ...noBucket, GCP_STAGED_ROLLOUT: 'true', AGENT_RUNTIME: 'adk_gemini' })).toBe(
      'The gcp profile is missing required settings: VERTEX_MODEL, VERTEX_LOCATION, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, GCS_BUCKET',
    );
  });

  it('the scheduler identity: a service account and an https backend URL make the endpoint audience', () => {
    expect(loadConfig(STAGED).scheduler).toEqual({
      serviceAccount: 'qwikspot-scheduler@qwikspot-prod.iam.gserviceaccount.com',
      audience: 'https://api.example.test/api/internal/process-due',
    });
    expect(() => loadConfig({ ...STAGED, SCHEDULER_SERVICE_ACCOUNT: 'someone@gmail.com' })).toThrow(
      /SCHEDULER_SERVICE_ACCOUNT/,
    );
    expect(loadConfig({}).scheduler).toBeNull();
  });
});
