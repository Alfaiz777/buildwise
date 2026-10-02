/**
 * scripts/secrets-scan.mjs (docs/07 §9, §15 "Secrets not exposed"): it catches each kind of
 * credential, never prints the value, and passes on the repository as committed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'secrets-scan.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

// Built at runtime so this test file never contains a key-shaped literal itself.
const r = (n: number, alphabet = 'abcdef0123456789') =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');
const SAMPLES: Record<string, string> = {
  'google.ts': `const k = '${'AI' + 'za'}${r(35)}';`,
  'pem.txt': `-----BEGIN ${'PRIVATE'} KEY-----\nabc\n`,
  'sa.json': JSON.stringify({ type: ['service', 'account'].join('_'), project_id: 'x' }),
  'shopify.ts': `const t = '${'shp' + 'at_'}${r(32)}';`,
  'meta.ts': `const t = '${'EA' + 'A'}${r(48, 'ABCDEFGHJK0123456789')}';`,
  'generic.ts': `const config = { client_secret: '${r(24)}' };`,
};
const dir = mkdtempSync(join(tmpdir(), 'qs-secrets-'));
for (const [name, text] of Object.entries(SAMPLES)) writeFileSync(join(dir, name), text);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('secrets:scan', () => {
  it('flags every kind of credential, without printing the value', () => {
    const res = run(dir);
    expect(res.status).toBe(1);
    for (const kind of [
      'Google API key',
      'Private key block',
      'Service-account JSON',
      'Shopify access token',
      'Meta / WhatsApp access token',
      'Hard-coded secret',
    ]) {
      expect(res.stderr).toContain(kind);
    }
    for (const text of Object.values(SAMPLES)) expect(res.stderr).not.toContain(text.slice(12, 40));
  });

  it('passes on the repository as committed (and on the frontend bundle when built)', () => {
    const res = run();
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});
