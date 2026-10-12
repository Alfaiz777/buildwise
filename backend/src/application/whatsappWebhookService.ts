import { timingSafeEqual } from 'node:crypto';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { WebhookReceiptRepository } from '../ports/conversationRepositories.js';
import type { InboundMessage, MessagingProvider } from '../ports/messaging.js';
import type { WhatsAppConnectionStore } from '../ports/whatsapp.js';
import type { ConversationPipeline } from './conversation/pipeline.js';
import type { WhatsAppConnections } from './whatsappConnections.js';

interface WebhookBody {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: Record<string, unknown> }[] }[];
}

/** phone_number_quality_update `event` → our quality label (status only). */
const QUALITY: Record<string, string> = { UNFLAGGED: 'GREEN', UPGRADE: 'GREEN', FLAGGED: 'YELLOW', DOWNGRADE: 'RED' };

/**
 * The WhatsApp Cloud API webhook (L2-WhatsApp; docs/06 §10). GET answers Meta's subscription
 * check with WHATSAPP_VERIFY_TOKEN. POST verifies X-Hub-Signature-256 on the raw body (401
 * otherwise, nothing processed), answers 200 at once and then processes in the background
 * (Cloud Run keeps CPU after the response):
 *   messages        → the number's brand (whatsapp_numbers) → the SAME ConversationPipeline as
 *                     the simulator; a repeated wamid is dropped by the pipeline's idempotency stage.
 *                     An unknown number is logged by id only and ignored.
 *   statuses        → the message's delivery status (never backwards)
 *   account_update / phone_number_quality_update → the connection's status fields only
 * Nothing logged carries a phone number, a token or message text.
 */
export class WhatsAppWebhookService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      provider: MessagingProvider;
      verifyToken: string;
      connections: Pick<WhatsAppConnections, 'brandForPhoneNumber' | 'recordAccountEvent'>;
      store: Pick<WhatsAppConnectionStore, 'recordDeliveryStatus'>;
      pipeline: Pick<ConversationPipeline, 'handleInbound'>;
      receipts: Pick<WebhookReceiptRepository, 'complete' | 'fail'>;
      /** The brand the local dev number answers for (local profile only), else null. */
      devBrandId?: string | null;
      logger?: Logger;
    },
  ) {}

  private get log() {
    return this.deps.logger ?? silentLogger;
  }

  /** GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → the challenge, or null (403). */
  verifySubscription(query: Record<string, unknown>): string | null {
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (query['hub.mode'] !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
    const a = Buffer.from(token);
    const b = Buffer.from(this.deps.verifyToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return /^[\w-]{1,128}$/.test(challenge) ? challenge : null;
  }

  /** Verifies and queues the delivery; true → 200, false → 401 (bad signature). */
  accept(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
    try {
      this.deps.provider.verifyInbound({ headers, rawBody });
    } catch {
      return false;
    }
    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as WebhookBody;
    } catch {
      return true; // signed but not JSON: acknowledge, nothing to do
    }
    const work = this.process(body)
      .catch((err: unknown) => this.log.error('whatsapp.webhook_failed', { error: (err as Error).name }))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return true;
  }

  /** Waits for queued deliveries (tests and graceful shutdown). */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async process(body: WebhookBody): Promise<void> {
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        if (change.field === 'messages') await this.messages(value);
        else if (change.field === 'account_update' && entry.id) await this.accountUpdate(entry.id, value);
        else if (change.field === 'phone_number_quality_update' && entry.id) {
          const quality = QUALITY[String(value.event ?? '')];
          if (quality) await this.deps.connections.recordAccountEvent(entry.id, { qualityRating: quality });
        }
      }
    }
  }

  private async accountUpdate(wabaId: string, value: Record<string, unknown>) {
    const event = String(value.event ?? '');
    if (/RESTRICT|BAN|DISABLE|VIOLATION/.test(event) && !/REMOVED|UNBAN/.test(event)) {
      await this.deps.connections.recordAccountEvent(wabaId, { status: 'RESTRICTED' });
    } else if (/REMOVED|UNBAN|REINSTATE/.test(event)) {
      await this.deps.connections.recordAccountEvent(wabaId, { status: 'CONNECTED' });
    }
  }

  private async messages(value: Record<string, unknown>) {
    const phoneNumberId = String((value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id ?? '');
    const brandId = phoneNumberId
      ? await this.deps.connections.brandForPhoneNumber(phoneNumberId, this.deps.devBrandId ?? null)
      : null;
    if (!brandId) {
      this.log.warn('whatsapp.webhook_unknown_number', { phone_number_id: phoneNumberId || null });
      return;
    }
    for (const status of this.deps.provider.normalizeStatus({ brandId, value })) {
      await this.deps.store.recordDeliveryStatus(brandId, status);
    }
    let inbound: InboundMessage[];
    try {
      inbound = this.deps.provider.normalizeInbound({ brandId, value });
    } catch {
      return;
    }
    for (const message of inbound) {
      const key = `${message.channel}:${message.brandId}:MESSAGE:${message.externalMessageId}`;
      try {
        const run = await this.deps.pipeline.handleInbound(message);
        if (run.stoppedAt?.stage === 'IDEMPOTENCY') continue; // Meta re-delivered a wamid we already have
        await this.deps.receipts.complete(key, { conversation_id: run.context.conversationId ?? null });
      } catch (err) {
        await this.deps.receipts.fail(key);
        this.log.error('whatsapp.inbound_failed', { brand_id: brandId, error: (err as Error).name });
      }
    }
  }
}
