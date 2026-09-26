// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('architecture boundaries (docs/03_TECH_ARCHITECTURE.md §7)', () => {
  it('the browser app never imports the Firestore client SDK', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /from\s+['"](firebase\/firestore|firebase\/database|@firebase\/firestore)/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('frontend code reads only VITE_* variables (nothing else is bundled)', () => {
    const offenders = sourceFiles(SRC).filter((file) => /process\.env/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
