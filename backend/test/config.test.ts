import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

/** Fake values for every gcp setting (Change 14, G7) — never real secrets. */
export const GCP_REQUIRED_FAKE = {
  GCP_REGION: 'asia-south1',
  VERTEX_MODEL: 'gemini-test-model',
  VERTEX_LOCATION: 'asia-south1',
  WHATSAPP_ACCESS_TOKEN: 'fake-wa-token',
  WHATSAPP_PHONE_NUMBER_ID: '000000000000',
  WHATSAPP_APP_SECRET: 'fake-app-secret',
  WHATSAPP_VERIFY_TOKEN: 'fake-verify',
  SHOPIFY_SHOP_DOMAIN: 'demo-shop.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'fake-shopify-token',
  SHOPIFY_WEBHOOK_SECRET: 'fake-hook-secret',
  BIGQUERY_DATASET: 'qwikspot_events',
  GCS_BUCKET: 'qwikspot-uploads-test',
  DEMO_MODE: 'false',
  CORS_ALLOWED_ORIGINS: 'https://qwikspot.example.web.app',
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
    const config = loadConfig({ COMMERCE_PROVIDER: 'shopify', MESSAGING_CHANNELS: 'simulator,whatsapp' });
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
    const { WHATSAPP_APP_SECRET: _a, SHOPIFY_ADMIN_TOKEN: _b, ...rest } = GCP_REAL;
    let message = '';
    try {
      loadConfig({ ...rest, VERTEX_MODEL: '  ' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      'The gcp profile is missing required settings: VERTEX_MODEL, WHATSAPP_APP_SECRET, SHOPIFY_ADMIN_TOKEN',
    );
    expect(message).not.toMatch(/fake-|asia-south1/);
    expect(loadConfig(GCP_REAL).gcp).toMatchObject({
      region: 'asia-south1',
      firestoreDatabase: '(default)',
      vertex: { model: 'gemini-test-model' },
      shopify: { shopDomain: 'demo-shop.myshopify.com' },
      gcsBucket: 'qwikspot-uploads-test',
    });
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
