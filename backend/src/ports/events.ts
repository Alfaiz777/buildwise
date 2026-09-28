/**
 * EventSink port (docs/06_INTEGRATION_CONTRACTS.md §5).
 * Analytics export only: CommerceEvents are always written to Firestore first.
 */
import type { CommerceEvent } from '../domain/events.js';

export interface EventSink {
  readonly name: 'LOCAL' | 'BIGQUERY';
  emit(events: CommerceEvent[]): Promise<void>;
}
