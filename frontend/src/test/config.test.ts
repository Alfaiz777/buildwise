import { describe, expect, it } from 'vitest';
import { readConfig } from '../config';

const base = {
  VITE_FIREBASE_API_KEY: 'public-web-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-buildwise.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-buildwise',
  VITE_FIREBASE_APP_ID: '1:123:web:abc',
};

describe('readConfig', () => {
  it('defaults to a same-origin API and no emulator', () => {
    const config = readConfig(base);
    expect(config.apiBaseUrl).toBe('');
    expect(config.authEmulatorUrl).toBeNull();
  });

  it('strips a trailing slash from the API base URL', () => {
    expect(readConfig({ ...base, VITE_API_BASE_URL: 'https://api.test/' }).apiBaseUrl).toBe('https://api.test');
  });

  it('fails loudly when Firebase config is missing', () => {
    expect(() => readConfig({ ...base, VITE_FIREBASE_PROJECT_ID: '' })).toThrow(/VITE_FIREBASE_PROJECT_ID/);
  });
});
