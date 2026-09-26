import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ GOOGLE_CLOUD_PROJECT: 'demo-buildwise' });
    expect(config).toEqual({
      nodeEnv: 'development',
      port: 8080,
      projectId: 'demo-buildwise',
      corsAllowedOrigins: [],
      logLevel: 'info',
      usingEmulators: false,
    });
  });

  it('requires GOOGLE_CLOUD_PROJECT', () => {
    expect(() => loadConfig({})).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it('names invalid variables without echoing their values', () => {
    try {
      loadConfig({ GOOGLE_CLOUD_PROJECT: 'p', PORT: 'super-secret-value' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('PORT');
      expect((err as Error).message).not.toContain('super-secret-value');
    }
  });

  it('parses the CORS allowlist', () => {
    const config = loadConfig({
      GOOGLE_CLOUD_PROJECT: 'p',
      CORS_ALLOWED_ORIGINS: ' https://a.test ,https://b.test,, ',
    });
    expect(config.corsAllowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('refuses emulator hosts in production', () => {
    expect(() =>
      loadConfig({ GOOGLE_CLOUD_PROJECT: 'p', NODE_ENV: 'production', FIRESTORE_EMULATOR_HOST: 'localhost:8085' }),
    ).toThrow(/Emulator/);
  });

  it('detects emulator mode', () => {
    const config = loadConfig({ GOOGLE_CLOUD_PROJECT: 'p', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' });
    expect(config.usingEmulators).toBe(true);
  });
});
