import { describe, expect, it } from 'vitest';
import { readConfig } from '../config';

const gcp = {
  VITE_QWIKSPOT_PROFILE: 'gcp',
  VITE_FIREBASE_API_KEY: 'public-web-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'qwikspot-prod.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'qwikspot-prod',
  VITE_FIREBASE_APP_ID: '1:123:web:abc',
};

describe('readConfig', () => {
  it('local profile (default) needs no configuration and uses the Auth emulator', () => {
    const config = readConfig({});
    expect(config).toMatchObject({
      profile: 'local',
      firebase: { projectId: 'demo-qwikspot' },
      apiBaseUrl: '',
      authEmulatorUrl: 'http://127.0.0.1:9099',
    });
  });

  it('gcp profile uses the real config, same-origin API and no emulator', () => {
    const config = readConfig(gcp);
    expect(config).toMatchObject({ profile: 'gcp', firebase: { projectId: 'qwikspot-prod' }, authEmulatorUrl: null });
  });

  it('gcp profile fails loudly when Firebase config is missing', () => {
    expect(() => readConfig({ ...gcp, VITE_FIREBASE_PROJECT_ID: '' })).toThrow(/VITE_FIREBASE_PROJECT_ID/);
  });

  it('gcp profile refuses the Auth emulator', () => {
    expect(() => readConfig({ ...gcp, VITE_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099' })).toThrow(/refuses/);
  });

  it('rejects unknown profiles and strips a trailing slash from the API base URL', () => {
    expect(() => readConfig({ VITE_QWIKSPOT_PROFILE: 'prod' })).toThrow(/VITE_QWIKSPOT_PROFILE/);
    expect(readConfig({ VITE_API_BASE_URL: 'https://api.test/' }).apiBaseUrl).toBe('https://api.test');
  });
});
