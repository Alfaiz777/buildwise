import type { CommerceEventType } from '../domain/events.js';
import { hashedId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import type { CommerceEventRecord, CommerceEventRepository } from '../ports/conversationRepositories.js';
import type { EventSink } from '../ports/events.js';
import type { AuditRepository } from '../ports/repositories.js';

export interface EventInput {
  brandId: string;
  eventType: CommerceEventType;
  source: CommerceEventRecord['source'];
  customerId?: string | null;
  webSessionId?: string | null;
  entityReference?: string | null;
  payload?: CommerceEventRecord['payload'];
  /** Deterministic key: a replay with the same key is a no-op. */
  idempotencyKey: string;
  at: string;
}

/**
 * CommerceEvents are written to Firestore first, then exported through the EventSink
 * (docs/06 §5). Export is best-effort: a sink failure never fails the request.
 */
export class EventRecorder {
  constructor(
    private readonly deps: {
      events: CommerceEventRepository;
      sink: EventSink;
      audit: AuditRepository;
      logger?: Logger;
    },
  ) {}

  async record(input: EventInput): Promise<boolean> {
    const event: CommerceEventRecord = {
      eventId: hashedId('evt', `${input.brandId}:${input.idempotencyKey}`),
      brandId: input.brandId,
      customerId: input.customerId ?? null,
      webSessionId: input.webSessionId ?? null,
      eventType: input.eventType,
      source: input.source,
      entityReference: input.entityReference ?? null,
      payload: input.payload ?? {},
      timestamp: input.at,
      idempotencyKey: input.idempotencyKey,
    };
    const created = await this.deps.events.record(event);
    if (created) {
      try {
        await this.deps.sink.emit([
          {
            eventId: event.eventId,
            brandId: event.brandId,
            customerId: event.customerId,
            webSessionId: event.webSessionId,
            eventType: event.eventType,
            source: event.source,
            entityReference: event.entityReference,
            eventPayloadReference: null,
            timestamp: event.timestamp,
            idempotencyKey: event.idempotencyKey,
          },
        ]);
      } catch (err) {
        this.deps.logger?.warn('events.sink_emit_failed', {
          event_type: event.eventType,
          error: (err as Error).message,
        });
      }
    }
    return created;
  }

  /** Brand AuditEvent for system actions (never throws into the request path). */
  async audit(
    brandId: string,
    entry: {
      action: string;
      targetType: string;
      targetId: string;
      result?: 'SUCCESS' | 'DENIED' | 'FAILED';
      reasonCode?: string | null;
      actor?: { type: 'SYSTEM' | 'USER' | 'AGENT' | 'CUSTOMER'; id: string };
    },
  ): Promise<void> {
    try {
      await this.deps.audit.recordBrandEvent({
        brandId,
        actorType: entry.actor?.type ?? 'SYSTEM',
        actorId: entry.actor?.id ?? 'qwikspot',
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        result: entry.result ?? 'SUCCESS',
        reasonCode: entry.reasonCode ?? null,
      });
    } catch (err) {
      this.deps.logger?.warn('audit.write_failed', { action: entry.action, error: (err as Error).message });
    }
  }
}
