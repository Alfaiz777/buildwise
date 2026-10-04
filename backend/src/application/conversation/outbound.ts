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
import { resolveMessagingSettings } from '../../domain/brandSettings.js';
import { decorateParts } from '../../domain/messageParts.js';
import { MessagePartsError, validateMessage } from '../../domain/whatsappLimits.js';
import type { BrandRepository } from '../../ports/repositories.js';
import type {
  MessageParts,
  MessagingProvider,
  OutboundMessage,
  OutboundOption,
  SendResult,
} from '../../ports/messaging.js';
import type { EventRecorder } from '../eventRecorder.js';

/** A message the application wants to send (channel-neutral, docs/06 §11). */
export interface OutboundDraft {
  text: string;
  messageType: 'TEXT' | 'INTERACTIVE' | 'TEMPLATE';
  options?: OutboundOption[];
  /** Structured parts (Change 16): image/text header, footer, location, CTA, list button. */
  parts?: MessageParts;
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
  /** Backoff before each retry (docs/03 §16.2: up to 2 retries). Injectable for tests. */
  sendRetryDelaysMs?: readonly number[];
  /** Brand settings for the "Powered by Qwikspot" footer (Change 16). */
  brands?: BrandRepository;
  /** Public web origin that relative media paths resolve against (Change 16). */
  publicOrigin?: string;
}

export const SEND_RETRY_DELAYS_MS = [250, 1000] as const;
/** Failures that will not get better by retrying. */
const PERMANENT = new Set(['CHANNEL_DISABLED', 'INVALID_RECIPIENT', 'OPTED_OUT', 'MESSAGE_PARTS_INVALID']);

/**
 * provider.send with up to 2 retries and exponential backoff, always with the SAME
 * outbound request ID so the channel can de-duplicate (docs/03 §16.2, Change 14 G2).
 */
async function sendWithRetry(
  provider: MessagingProvider,
  outbound: OutboundMessage,
  delays: readonly number[],
): Promise<SendResult> {
  let last: SendResult = { status: 'FAILED', externalMessageId: null, errorCode: 'SEND_ERROR' };
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
    try {
      last = await provider.send(outbound);
    } catch {
      last = { status: 'FAILED', externalMessageId: null, errorCode: 'SEND_ERROR' };
    }
    if (last.status !== 'FAILED' || PERMANENT.has(last.errorCode ?? '')) return last;
  }
  return last;
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
  // Channel decoration (Change 16): absolute media URLs and the "Powered by Qwikspot" footer.
  const settings =
    draft.options?.length || draft.parts ? ((await deps.brands?.getById(conversation.brandId))?.settings ?? {}) : {};
  const brandMessaging = resolveMessagingSettings(settings, '');
  draft = {
    ...draft,
    parts: decorateParts({
      options: draft.options,
      parts: draft.parts,
      author: draft.origin,
      poweredByFooter: brandMessaging.poweredByFooter,
      publicOrigin: deps.publicOrigin ?? 'http://localhost:5173',
    }),
  };
  // WhatsApp's limits apply on every channel (Change 16): what is stored is what was sent.
  let valid: { text: string; options?: OutboundOption[]; parts?: MessageParts } | null;
  try {
    valid = validateMessage({ text: draft.text, options: draft.options, parts: draft.parts });
  } catch (err) {
    if (!(err instanceof MessagePartsError)) throw err;
    valid = null;
  }
  const body = valid ?? { text: draft.text, options: draft.options, parts: draft.parts };
  const outbound: OutboundMessage = {
    brandId: conversation.brandId,
    customerId: customer.customerId,
    conversationId: conversation.conversationId,
    externalCustomerRef: identity?.externalRef ?? '',
    messageType: draft.messageType,
    text: body.text,
    options: body.options,
    parts: body.parts,
    actionReference: draft.actionReference,
    outboundRequestId: messageId,
  };

  const provider = deps.messaging.get(conversation.channel);
  const result: SendResult = !valid
    ? { status: 'FAILED', externalMessageId: null, errorCode: 'MESSAGE_PARTS_INVALID' }
    : provider && identity
      ? await sendWithRetry(provider, outbound, deps.sendRetryDelaysMs ?? SEND_RETRY_DELAYS_MS)
      : { status: 'FAILED' as const, externalMessageId: null, errorCode: 'CHANNEL_DISABLED' };

  const message: MessageRecord = {
    messageId,
    brandId: conversation.brandId,
    conversationId: conversation.conversationId,
    direction: 'OUTBOUND',
    messageType: draft.messageType,
    text: body.text,
    options: body.options ?? null,
    location: null,
    parts: body.parts ?? null,
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
    source: 'QWIKSPOT',
    customerId: customer.customerId,
    entityReference: messageId,
    payload: {
      conversation_id: conversation.conversationId,
      origin: draft.origin,
      message_kind: draft.messageKind,
      delivery_status: result.status,
    },
    idempotencyKey: `MESSAGE_SENT:${messageId}`,
    at: message.timestamp,
  });
  return { message, outbound };
}
