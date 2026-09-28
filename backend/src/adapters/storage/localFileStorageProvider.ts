import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { assertValidStorageKey, type FileStorageProvider, type UploadTarget } from '../../ports/fileStorage.js';

/**
 * Local-profile file storage under `<dataDir>/files`.
 * Upload targets point at the local-only backend endpoint
 * PUT /api/local-files/uploads/:uploadId (implemented with retail ingestion, M4).
 */
export class LocalFileStorageProvider implements FileStorageProvider {
  readonly name = 'LOCAL' as const;
  private readonly root: string;

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly uploadTtlMs = 15 * 60 * 1000,
  ) {
    this.root = resolve(dataDir, 'files');
  }

  /** Resolves a key inside the root; never escapes it. */
  pathFor(key: string): string {
    assertValidStorageKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async createUploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget> {
    this.pathFor(key);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
    return {
      method: 'PUT',
      url: `/api/local-files/uploads/${randomUUID()}`,
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(this.now().getTime() + this.uploadTtlMs).toISOString(),
    };
  }

  async openRead(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await access(path);
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
