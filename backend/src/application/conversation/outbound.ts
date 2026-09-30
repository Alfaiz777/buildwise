import type { Channel } from '../../domain/channels.js';
import type { MessageKind } from '../../domain/conversationPolicy.js';
import { sortableId } from '../../lib/ids.js';
import type {
  ConversationRecord,
  ConversationRepository,
  CustomerRecord,
  MessageOrigin,
  MessageRecord,
} from '../../ports/conversationRepositories.js';
import type { MessagingProvider, OutboundMessage } from '../../ports/messaging.js';
import type { EventRecorder } from '../eventRecorder.js';

/** A message the application wants to send (channel-neutral, docs/06 §11). */
export interface OutboundDraft {
  text: string;
  messageType: 'TEXT' | 'INTERACTIVE' | 'TEMPLATE';
  options?: { optionId: string; label: string }[];
  origin: Exclude<MessageOrigin, 'CUSTOMER'>;
  messageKind: MessageKind;
  templateName: string | null;
  actionReference: string | null;
}

export interface OutboundDeps {
  conversations: ConversationRepository;
  messaging: ReadonlyMap<Channel, MessagingProvider>;
  events: EventRecorder;
  now: () => Date;
}

/**
 * Step 10 of the pipeline, shared with the proactive follow-up path: hand the message to
 * the MessagingProvider of the conversation's channel, then persist the outbound
 * ConversationMessage with its delivery status and emit MESSAGE_SENT. Policy (consent,
 * opt-out, window, handoff) must already have been applied by the caller.
 */
export async function sendAndPersist(
  deps: OutboundDeps,
  conversation: ConversationRecord,
  customer: CustomerRecord,
  draft: OutboundDraft,
): Promise<{ message: MessageRecord; outbound: OutboundMessage }> {
  const now = deps.now();
  const messageId = sortableId('msg', now);
  const identity = customer.channelIdentities.find((i) => i.channel === conversation.channel);
  const outbound: OutboundMessage = {
    brandId: conversation.brandId,
    customerId: customer.customerId,
    conversationId: conversation.conversationId,
    externalCustomerRef: identity?.externalRef ?? '',
    messageType: draft.messageType,
    text: draft.text,
    options: draft.options,
    actionReference: draft.actionReference,
    outboundRequestId: messageId,
  };

  const provider = deps.messaging.get(conversation.channel);
  const result =
    provider && identity
      ? await provider.send(outbound)
      : { status: 'FAILED' as const, externalMessageId: null, errorCode: 'CHANNEL_DISABLED' };

  const message: MessageRecord = {
    messageId,
    brandId: conversation.brandId,
    conversationId: conversation.conversationId,
    direction: 'OUTBOUND',
    messageType: draft.messageType,
    text: draft.text,
    options: draft.options ?? null,
    location: null,
    origin: draft.origin,
    messageKind: draft.messageKind,
    templateName: draft.templateName,
    externalMessageId: result.externalMessageId,
    deliveryStatus: result.status,
    timestamp: now.toISOString(),
  };
  await deps.conversations.addMessage(message);
  await deps.conversations.update(conversation.brandId, conversation.conversationId, {
    lastMessageAt: message.timestamp,
    updatedAt: message.timestamp,
  });
  await deps.events.record({
    brandId: conversation.brandId,
    eventType: 'MESSAGE_SENT',
    source: 'BUILDWISE',
    customerId: customer.customerId,
    entityReference: messageId,
    payload: { conversation_id: conversation.conversationId, origin: draft.origin, message_kind: draft.messageKind },
    idempotencyKey: `MESSAGE_SENT:${messageId}`,
    at: message.timestamp,
  });
  return { message, outbound };
}
