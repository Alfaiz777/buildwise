/** FileStorageProvider port (docs/06_INTEGRATION_CONTRACTS.md §6a). */
import type { Readable } from 'node:stream';

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  /** ISO-8601 */
  expiresAt: string;
}

export interface FileStorageProvider {
  readonly name: 'LOCAL' | 'GCS';
  createUploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget>;
  openRead(key: string): Promise<Readable>;
  /** Server-side write (e.g. an import's row-error report). */
  write(key: string, body: string | Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A pending browser upload issued by createUploadTarget (local profile only). */
export interface PendingUpload {
  key: string;
  contentType: string;
  maxBytes: number;
  /** ISO-8601 */
  expiresAt: string;
}

/**
 * Receives browser uploads for LocalFileStorageProvider through the backend endpoint
 * PUT /api/local-files/uploads/:uploadId. In gcp the browser uploads to a signed URL
 * instead, so this is wired only in the local profile.
 */
export interface LocalUploadReceiver {
  /** The pending upload, or null if it is unknown or expired. */
  describeUpload(uploadId: string): PendingUpload | null;
  /** Stores the body under the upload's key and consumes the upload. */
  acceptUpload(uploadId: string, body: Buffer): Promise<PendingUpload>;
}

/** Keys are relative, slash-separated and cannot escape their root. */
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,511}$/;

export function assertValidStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error('Invalid storage key');
  }
}
