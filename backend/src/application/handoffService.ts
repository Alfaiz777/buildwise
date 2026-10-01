import { inServiceWindow } from '../domain/conversationPolicy.js';
import type { BrandPrincipal } from '../domain/principal.js';
import { AppError, Errors } from '../lib/errors.js';
import type { ConversationRepository, CustomerRepository, MessageRecord } from '../ports/conversationRepositories.js';
import { sendAndPersist, type OutboundDeps } from './conversation/outbound.js';

export const HUMAN_REPLY_MAX = 1000;

/**
 * The Brand Console handoff queue (docs/00 §11.8 Change 13, F7): a Brand Admin replies as a
 * person to a conversation a customer handed over, then returns it to the assistant. The
 * reply goes through the same outbound path and policy (opt-out, 24-hour window); the
 * sender's uid is recorded only in the AuditEvent, never in the message.
 */
export class HandoffService {
  constructor(
    private readonly deps: OutboundDeps & { customers: CustomerRepository; conversations: ConversationRepository },
  ) {}

  private async owned(principal: BrandPrincipal, conversationId: string) {
    const conversation = await this.deps.conversations.get(principal.brandId, conversationId);
    if (!conversation) throw Errors.notFound();
    return conversation;
  }

  async reply(principal: BrandPrincipal, conversationId: string, rawText: string): Promise<MessageRecord> {
    const conversation = await this.owned(principal, conversationId);
    const text = rawText.trim().slice(0, HUMAN_REPLY_MAX);
    if (!text) throw Errors.invalidRequest('Write a reply first.');
    if (!conversation.humanHandoff) {
      throw new AppError(
        409,
        'NOT_IN_HANDOFF',
        'The assistant owns this conversation; replies as a person need a handoff.',
      );
    }
    const customer = await this.deps.customers.get(principal.brandId, conversation.customerId);
    if (!customer || customer.consentState === 'OPTED_OUT') {
      throw new AppError(409, 'CUSTOMER_OPTED_OUT', 'The customer opted out; no message can be sent.');
    }
    // A free-text business message is allowed only inside the customer-service window (WhatsApp policy).
    if (!inServiceWindow(conversation.lastInboundAt, this.deps.now())) {
      throw new AppError(
        409,
        'OUTSIDE_SERVICE_WINDOW',
        'More than 24 hours since the customer last wrote; a free-text reply is not allowed.',
      );
    }
    const { message } = await sendAndPersist(this.deps, conversation, customer, {
      text,
      messageType: 'TEXT',
      origin: 'HUMAN_AGENT',
      messageKind: 'SESSION',
      templateName: null,
      actionReference: null,
    });
    await this.deps.events.audit(principal.brandId, {
      action: 'HUMAN_REPLY_SENT',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      actor: { type: 'USER', id: principal.userId },
    });
    return message;
  }

  async resolve(principal: BrandPrincipal, conversationId: string): Promise<void> {
    const conversation = await this.owned(principal, conversationId);
    if (!conversation.humanHandoff) return; // already with the assistant: idempotent
    const at = this.deps.now().toISOString();
    await this.deps.conversations.update(principal.brandId, conversationId, {
      humanHandoff: false,
      handoffAt: null,
      updatedAt: at,
    });
    await this.deps.events.audit(principal.brandId, {
      action: 'HUMAN_HANDOFF_RESOLVED',
      targetType: 'CONVERSATION',
      targetId: conversationId,
      actor: { type: 'USER', id: principal.userId },
    });
  }
}
