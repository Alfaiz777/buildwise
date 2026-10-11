import type { CommerceEvent } from '../../domain/events.js';
import { silentLogger, type Logger } from '../../lib/logger.js';
import type { EventSink } from '../../ports/events.js';

/** One streaming-insert row in raw form: BigQuery de-duplicates retries by `insertId`. */
export interface BigQueryRawRow {
  insertId: string;
  json: Record<string, string | null>;
}

/** The slice of `@google-cloud/bigquery`'s Table this adapter uses (a fake in unit tests). */
export interface BigQueryTableLike {
  insert(rows: BigQueryRawRow[], options: { raw: true }): Promise<unknown>;
}

/** CommerceEvent → a row of the `events` table (infrastructure/bigquery/events.schema.json). */
export function eventRow(event: CommerceEvent): BigQueryRawRow {
  return {
    insertId: event.eventId,
    json: {
      event_id: event.eventId,
      brand_id: event.brandId,
      customer_id: event.customerId,
      web_session_id: event.webSessionId,
      event_type: event.eventType,
      source: event.source,
      entity_reference: event.entityReference,
      event_payload_reference: event.eventPayloadReference,
      event_timestamp: event.timestamp,
      idempotency_key: event.idempotencyKey,
    },
  };
}

/**
 * gcp-profile analytics export (L1): streaming inserts into BIGQUERY_DATASET.events, with
 * `insertId` = the event id so a retried insert is not counted twice. The request path never
 * waits for BigQuery or fails because of it: `emit` queues the insert and returns at once
 * (Cloud Run runs with CPU always allocated, so background work completes); a failure is
 * logged with the event ids and an error code only — never row data (docs/07 §11).
 * Credentials: the Cloud Run service account (ADC), `bigquery.dataEditor` on the dataset.
 */
export class BigQueryEventSink implements EventSink {
  readonly name = 'BIGQUERY' as const;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly table: BigQueryTableLike,
    private readonly logger: Logger = silentLogger,
  ) {}

  emit(events: CommerceEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    const insert = this.insert(events).finally(() => this.pending.delete(insert));
    this.pending.add(insert);
    return Promise.resolve();
  }

  /** Waits for every queued insert (shutdown and tests). Never rejects. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async insert(events: CommerceEvent[]): Promise<void> {
    try {
      await this.table.insert(events.map(eventRow), { raw: true });
    } catch (err) {
      const e = err as { code?: unknown; name?: unknown };
      this.logger.warn('events.bigquery_insert_failed', {
        event_ids: events.map((x) => x.eventId),
        error_code:
          typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : String(e.name ?? 'ERROR'),
      });
    }
  }
}
