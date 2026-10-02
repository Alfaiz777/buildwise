import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FixtureSource } from '../../ports/demoData.js';

/**
 * Reads backend/fixtures — from src/ locally and from dist/ in the container (the
 * Dockerfile copies backend/fixtures next to backend/dist). Only plain relative paths.
 */
export class BundledFixtureSource implements FixtureSource {
  constructor(private readonly root = fileURLToPath(new URL('../../../fixtures/', import.meta.url))) {}

  async read(path: string): Promise<Buffer> {
    if (!/^[a-z0-9_-]+(\/[a-z0-9_.-]+)*$/i.test(path) || path.includes('..')) {
      throw new Error('fixture path must be a plain relative path');
    }
    return readFile(`${this.root}${path}`);
  }
}
