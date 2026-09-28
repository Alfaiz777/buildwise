/**
 * MessagingProvider port (docs/06_INTEGRATION_CONTRACTS.md §3, §11).
 * One adapter per customer channel. Adapters verify, normalize and transport
 * only: consent / opt-out / window policy lives in the ConversationPipeline.
 */
import type { Channel } from '../domain/channels.js';

export type InboundContent =
  | { type: 'TEXT'; text: string }
  | { type: 'LOCATION'; latitude: number; longitude: number }
  | { type: 'INTERACTIVE_REPLY'; optionId: string };

/** Channel-neutral inbound message. */
export interface InboundMessage {
  channel: Channel;
  brandId: string;
  /** WhatsApp ID, or `sim:{simulator_customer_ref}` for the simulator. */
  externalCustomerRef: string;
  /** wamid, or the simulator's client_message_id. */
  externalMessageId: string;
  /** ISO-8601 */
  receivedAt: string;
  content: InboundContent;
}

export interface OutboundOption {
  optionId: string;
  label: string;
}

/** Channel-neutral outbound message (06 §11). */
export interface OutboundMessage {
  brandId: string;
  customerId: string;
  conversationId: string;
  /** Resolved by the pipeline from the customer's channel identity. */
  externalCustomerRef: string;
  messageType: 'TEXT' | 'INTERACTIVE' | 'TEMPLATE';
  text: string;
  options?: OutboundOption[];
  actionReference: string | null;
  /** Stable ID so retries do not send duplicates. */
  outboundRequestId: string;
}

export interface SendResult {
  status: 'SENT' | 'DELIVERED' | 'FAILED';
  externalMessageId: string | null;
  errorCode: string | null;
}

export interface DeliveryStatusUpdate {
  externalMessageId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  /** ISO-8601 */
  timestamp: string;
}

/** Transport-level view of an inbound HTTP request, for signature verification. */
export interface InboundRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer | null;
}

export interface MessagingProvider {
  readonly channel: Channel;
  /** Throws when the request is not authentic (e.g. bad WhatsApp signature). */
  verifyInbound(request: InboundRequest): void;
  normalizeInbound(raw: unknown): InboundMessage[];
  normalizeStatus(raw: unknown): DeliveryStatusUpdate[];
  send(message: OutboundMessage): Promise<SendResult>;
}
