/** L1 test doubles for the GCP client libraries (no network in `npm test`). */
import { Readable } from 'node:stream';
import type { GcsBucketLike, GcsFileLike } from '../src/adapters/storage/gcsFileStorageProvider.js';

/** An in-memory Cloud Storage bucket with the behaviour the adapter relies on. */
export class InMemoryGcsBucket implements GcsBucketLike {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  readonly signed: { name: string; contentType: string; expires: number; headers: Record<string, string> }[] = [];

  file(name: string): GcsFileLike {
    const objects = this.objects;
    const signed = this.signed;
    return {
      async save(data, options) {
        objects.set(name, { data: Buffer.from(data), contentType: options.contentType });
      },
      async exists() {
        return [objects.has(name)];
      },
      createReadStream() {
        const o = objects.get(name);
        if (!o) {
          const r = new Readable({ read() {} });
          process.nextTick(() => r.destroy(new Error('No such object')));
          return r;
        }
        return Readable.from([o.data]);
      },
      async delete() {
        objects.delete(name);
      },
      async getSignedUrl(options) {
        signed.push({
          name,
          contentType: options.contentType,
          expires: options.expires,
          headers: options.extensionHeaders ?? {},
        });
        return [`https://storage.googleapis.com/test-bucket/${encodeURI(name)}?X-Goog-Signature=fake`];
      },
    };
  }
}

/** A BigQuery `events` table that records raw rows; `failWith` makes the next inserts reject. */
export class FakeBigQueryTable {
  readonly rows: { insertId: string; json: Record<string, string | null> }[] = [];
  failWith: (Error & { code?: unknown }) | null = null;
  /** Resolves when the test calls release(); lets a test prove emit() did not wait. */
  gate: Promise<void> | null = null;

  async insert(rows: { insertId: string; json: Record<string, string | null> }[], _options: { raw: true }) {
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    // BigQuery best-effort de-duplication by insertId.
    for (const row of rows) if (!this.rows.some((r) => r.insertId === row.insertId)) this.rows.push(row);
  }
}
