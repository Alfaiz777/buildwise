#!/usr/bin/env node
/**
 * `npm run emulators` with persistent local data (L2-Shopify): Auth + Firestore keep their
 * data in ./.emulator-data (git-ignored) between runs — e.g. a connected Shopify store.
 * Firebase refuses an --import directory without an export, so the first run starts
 * empty and only exports on exit. Delete .emulator-data to start fresh.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const DIR = './.emulator-data';
const args = [
  'emulators:start',
  '--project',
  'demo-qwikspot',
  '--only',
  'auth,firestore',
  `--export-on-exit=${DIR}`,
  ...(existsSync(`${DIR}/firebase-export-metadata.json`) ? [`--import=${DIR}`] : []),
];
console.log(`firebase ${args.join(' ')}`);
const child = spawn('firebase', args, { stdio: 'inherit', shell: process.platform === 'win32' });
// Ctrl+C reaches firebase too; it exports, then exits.
process.on('SIGINT', () => {});
child.on('exit', (code) => process.exit(code ?? 0));
