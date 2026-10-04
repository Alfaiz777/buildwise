import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MessagePartsError, validateMessage } from '../../domain/whatsappLimits.js';
import type {
  DeliveryStatusUpdate,
  InboundMessage,
  MessagingProvider,
  OutboundMessage,
  SendResult,
} from '../../ports/messaging.js';

/**
 * The simulator is a customer-channel adapter (docs/06_INTEGRATION_CONTRACTS.md §14.2).
 * It only translates simulator requests into channel-neutral InboundMessages;
 * everything else happens in the same ConversationPipeline as WhatsApp.
 *
 * `send()` never contacts an external service. The pipeline persists every
 * outbound ConversationMessage (M4), and the simulator UI reads the conversation.
 */

/** What the simulator route hands over: the verified brand plus the request body. */
const SimulatorInbound = z.object({
  brandId: z.string().min(1),
  receivedAt: z.string().min(1),
  body: z.object({
    simulator_customer_ref: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    client_message_id: z.string().min(1).max(128),
    content: z.discriminatedUnion('type', [
      z.object({ type: z.literal('TEXT'), text: z.string().min(1).max(4000) }),
      z.object({
        type: z.literal('LOCATION'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
      z.object({ type: z.literal('INTERACTIVE_REPLY'), option_id: z.string().min(1).max(128) }),
    ]),
  }),
});

export type SimulatorInboundRaw = z.input<typeof SimulatorInbound>;

export class SimulatorMessagingProvider implements MessagingProvider {
  readonly channel = 'SIMULATOR' as const;

  /** Simulator requests are authenticated by the console auth chain (BRAND_ADMIN), not by a signature. */
  verifyInbound(): void {}

  normalizeInbound(raw: unknown): InboundMessage[] {
    const { brandId, receivedAt, body } = SimulatorInbound.parse(raw);
    const content: InboundMessage['content'] =
      body.content.type === 'INTERACTIVE_REPLY'
        ? { type: 'INTERACTIVE_REPLY', optionId: body.content.option_id }
        : body.content;
    return [
      {
        channel: 'SIMULATOR',
        brandId,
        externalCustomerRef: `sim:${body.simulator_customer_ref}`,
        externalMessageId: body.client_message_id,
        receivedAt,
        content,
      },
    ];
  }

  /** The simulator has no asynchronous delivery receipts. */
  normalizeStatus(): DeliveryStatusUpdate[] {
    return [];
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.externalCustomerRef.startsWith('sim:')) {
      return { status: 'FAILED', externalMessageId: null, errorCode: 'NOT_A_SIMULATOR_CUSTOMER' };
    }
    // The simulator renders only what WhatsApp can (Change 16): the same check as the L2 adapter.
    try {
      validateMessage(message);
    } catch (err) {
      if (err instanceof MessagePartsError) {
        return { status: 'FAILED', externalMessageId: null, errorCode: 'MESSAGE_PARTS_INVALID' };
      }
      throw err;
    }
    return { status: 'DELIVERED', externalMessageId: `sim_${randomUUID()}`, errorCode: null };
  }
}
