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
  delete(key: string): Promise<void>;
}

/** Keys are relative, slash-separated and cannot escape their root. */
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,511}$/;

export function assertValidStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error('Invalid storage key');
  }
}
