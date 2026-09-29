import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  assertValidStorageKey,
  type FileStorageProvider,
  type LocalUploadReceiver,
  type PendingUpload,
  type UploadTarget,
} from '../../ports/fileStorage.js';

/**
 * Local-profile file storage under `<dataDir>/files`.
 * Upload targets point at the local-only backend endpoint
 * PUT /api/local-files/uploads/:uploadId, which hands the body to acceptUpload().
 * Pending uploads live in memory: a backend restart simply requires a new upload.
 */
export class LocalFileStorageProvider implements FileStorageProvider, LocalUploadReceiver {
  readonly name = 'LOCAL' as const;
  private readonly root: string;
  private readonly pending = new Map<string, PendingUpload>();

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
    const uploadId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + this.uploadTtlMs).toISOString();
    this.pending.set(uploadId, { key, contentType, maxBytes, expiresAt });
    return {
      method: 'PUT',
      url: `/api/local-files/uploads/${uploadId}`,
      headers: { 'Content-Type': contentType },
      expiresAt,
    };
  }

  describeUpload(uploadId: string): PendingUpload | null {
    const upload = this.pending.get(uploadId);
    if (!upload) return null;
    if (new Date(upload.expiresAt).getTime() <= this.now().getTime()) {
      this.pending.delete(uploadId);
      return null;
    }
    return upload;
  }

  async acceptUpload(uploadId: string, body: Buffer): Promise<PendingUpload> {
    const upload = this.describeUpload(uploadId);
    if (!upload) throw new Error('Unknown or expired upload');
    if (body.length > upload.maxBytes) throw new Error('Upload exceeds its size limit');
    await this.write(upload.key, body, upload.contentType);
    this.pending.delete(uploadId);
    return upload;
  }

  async write(key: string, body: string | Buffer, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
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
