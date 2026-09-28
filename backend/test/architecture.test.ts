/**
 * Layering rules (docs/03_TECH_ARCHITECTURE.md §2.1, docs/08_TEST_PLAN.md §4.1):
 * domain/, application/ and ports/ never depend on adapters, Firebase or the
 * composition root; only composition/ chooses adapters.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

const FORBIDDEN_FOR_CORE = [/\/adapters\//, /\/composition\//, /^firebase-admin/, /^express$/, /\/routes\//];

describe('architecture boundaries', () => {
  for (const layer of ['domain', 'application', 'ports']) {
    it(`${layer}/ depends only on ports/domain/lib — never on adapters, Firebase, Express or composition`, () => {
      const offenders = files(join(SRC, layer)).flatMap((file) =>
        importsOf(file)
          .filter((spec) => FORBIDDEN_FOR_CORE.some((pattern) => pattern.test(spec)))
          .map((spec) => `${relative(SRC, file)} → ${spec}`),
      );
      expect(offenders).toEqual([]);
    });
  }

  it('only composition/ (and tests) import adapter implementations', () => {
    const offenders = files(SRC)
      .filter((file) => !relative(SRC, file).startsWith('composition') && !relative(SRC, file).startsWith('adapters'))
      .flatMap((file) =>
        importsOf(file)
          .filter((spec) => spec.includes('/adapters/'))
          .map((spec) => `${relative(SRC, file)} → ${spec}`),
      );
    expect(offenders).toEqual([]);
  });

  it('adapters never import application services (no business logic in adapters)', () => {
    const offenders = files(join(SRC, 'adapters')).flatMap((file) =>
      importsOf(file)
        .filter((spec) => spec.includes('/application/'))
        .map((spec) => `${relative(SRC, file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
