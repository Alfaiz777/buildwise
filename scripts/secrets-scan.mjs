#!/usr/bin/env node
/**
 * npm run secrets:scan — fails (exit 1) if a credential-looking string is about to be
 * committed or shipped to browsers (docs/07 §9, §15). No dependencies.
 *
 * Scans:
 *   1. every file git would commit (tracked + untracked-but-not-ignored);
 *   2. the built frontend bundle (frontend/dist, when present): key-like strings AND the
 *      local demo password — demo logins reach the browser only at runtime from
 *      GET /api/demo/config when DEMO_MODE is on, never inside the bundle.
 * Usage: node scripts/secrets-scan.mjs [path ...]   (explicit paths replace step 1)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const display = (abs) => relative(ROOT, abs).replaceAll('\\', '/');

/** [name, pattern]. Patterns are built so this file never matches itself. */
const RULES = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Private key block', new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----')],
  ['Service-account JSON', /"type"\s*:\s*"service_account"/],
  ['Shopify access token', /shp(at|ss|ca|pa)_[0-9a-fA-F]{32}/],
  ['Meta / WhatsApp access token', /\bEAA[A-Za-z0-9]{40,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{36}\b/],
  [
    'Hard-coded secret',
    /\b(secret|password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  ],
];

/** Demo-only values that are allowed in the repo but must never be in the frontend bundle. */
const BUNDLE_ONLY_RULES = [['Demo password in the frontend bundle', /qwikspot-demo-1/]];

/** Files that may legitimately contain key-shaped placeholders. */
const ALLOW_FILES = [/^package-lock\.json$/, /(^|\/)\.env\.example$/];
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz)$/i;
const MAX_BYTES = 2_000_000;

function committableFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function scan(abs, rules) {
  const file = display(abs);
  if (!existsSync(abs) || BINARY.test(file) || statSync(abs).size > MAX_BYTES) return [];
  const lines = readFileSync(abs, 'utf8').split('\n');
  const findings = [];
  lines.forEach((line, i) => {
    for (const [name, re] of rules) if (re.test(line)) findings.push(`${file}:${i + 1}  ${name}`);
  });
  return findings;
}

const explicit = process.argv.slice(2).map((p) => resolve(p));
const sources = explicit.length
  ? explicit.flatMap((p) => (statSync(p).isDirectory() ? walk(p) : [p]))
  : committableFiles().map((f) => join(ROOT, f));
const findings = sources
  .filter((abs) => !ALLOW_FILES.some((re) => re.test(display(abs))))
  .flatMap((abs) => scan(abs, RULES));

const dist = join(ROOT, 'frontend', 'dist');
let bundleFiles = 0;
if (!explicit.length && existsSync(dist)) {
  for (const abs of walk(dist)) {
    bundleFiles++;
    findings.push(...scan(abs, [...RULES, ...BUNDLE_ONLY_RULES]));
  }
}

if (findings.length) {
  console.error(`✘ secrets:scan found ${findings.length} possible secret(s) (values not printed):`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('Move real values to environment variables / Secret Manager (docs/12 runbook).');
  process.exit(1);
}
console.log(
  `✔ secrets:scan — ${sources.length} files${bundleFiles ? ` + ${bundleFiles} frontend bundle files` : ' (frontend/dist not built, bundle not scanned)'}: no secrets found.`,
);
