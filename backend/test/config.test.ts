import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const GCP_REAL = {
  BUILDWISE_PROFILE: 'gcp',
  GOOGLE_CLOUD_PROJECT: 'buildwise-prod',
  NODE_ENV: 'production',
} as const;

describe('loadConfig — local profile (default)', () => {
  it('needs no configuration at all and never requires Google Cloud', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 8080,
      profile: 'local',
      projectId: 'demo-buildwise',
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
    expect(() => loadConfig({ BUILDWISE_PROFILE: 'staging' })).toThrow(/BUILDWISE_PROFILE/);
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
      projectId: 'buildwise-prod',
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
    expect(() => loadConfig({ BUILDWISE_PROFILE: 'gcp' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
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

  it('lists every violation at once', () => {
    expect(() => loadConfig({ ...GCP_REAL, COMMERCE_PROVIDER: 'mock', AGENT_RUNTIME: 'mock' })).toThrow(
      /COMMERCE_PROVIDER=mock, AGENT_RUNTIME=mock/,
    );
  });
});
