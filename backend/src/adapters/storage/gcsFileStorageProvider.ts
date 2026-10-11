import type { Readable } from 'node:stream';
import { assertValidStorageKey, type FileStorageProvider, type UploadTarget } from '../../ports/fileStorage.js';

/**
 * The slice of `@google-cloud/storage`'s Bucket this adapter uses — so unit tests run the
 * same contract against an in-memory bucket (no network in `npm test`).
 */
export interface GcsBucketLike {
  file(name: string): GcsFileLike;
}

export interface GcsFileLike {
  save(data: string | Buffer, options: { contentType: string; resumable: boolean }): Promise<unknown>;
  exists(): Promise<[boolean]>;
  createReadStream(): Readable;
  delete(options: { ignoreNotFound: boolean }): Promise<unknown>;
  getSignedUrl(options: {
    version: 'v4';
    action: 'write';
    expires: number;
    contentType: string;
    extensionHeaders?: Record<string, string>;
  }): Promise<[string]>;
}

/**
 * gcp-profile file storage in one Cloud Storage bucket (GCS_BUCKET), with the same keys as
 * LocalFileStorageProvider (relative, slash-separated, validated by assertValidStorageKey).
 * Credentials come from the Cloud Run service account (ADC) — no key files.
 *
 * Browser uploads go straight to a V4 signed PUT URL valid for 15 minutes; the browser must
 * send the target's headers: `Content-Type` and `x-goog-content-length-range` (GCS refuses a
 * body larger than `maxBytes`). Signing uses the service account's IAM signBlob permission
 * (`roles/iam.serviceAccountTokenCreator` on itself). The bucket's CORS must allow PUT from the
 * web origin with those headers (infrastructure/scripts/setup-project.sh).
 */
export class GCSFileStorageProvider implements FileStorageProvider {
  readonly name = 'GCS' as const;

  constructor(
    private readonly bucket: GcsBucketLike,
    private readonly now: () => Date = () => new Date(),
    private readonly uploadTtlMs = 15 * 60 * 1000,
  ) {}

  private file(key: string): GcsFileLike {
    assertValidStorageKey(key);
    return this.bucket.file(key);
  }

  async createUploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget> {
    const file = this.file(key);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
    const expires = this.now().getTime() + this.uploadTtlMs;
    const sizeRange = `0,${maxBytes}`;
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType,
      extensionHeaders: { 'x-goog-content-length-range': sizeRange },
    });
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': contentType, 'x-goog-content-length-range': sizeRange },
      expiresAt: new Date(expires).toISOString(),
    };
  }

  async write(key: string, body: string | Buffer, contentType: string): Promise<void> {
    await this.file(key).save(body, { contentType, resumable: false });
  }

  /** Rejects when the object does not exist (like the local provider), before any stream is handed out. */
  async openRead(key: string): Promise<Readable> {
    const file = this.file(key);
    const [exists] = await file.exists();
    if (!exists) throw new Error('File not found');
    return file.createReadStream();
  }

  async delete(key: string): Promise<void> {
    await this.file(key).delete({ ignoreNotFound: true });
  }
}
