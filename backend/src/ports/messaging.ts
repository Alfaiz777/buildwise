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

/**
 * One choice the customer can tap (docs/06 §11). The layout is derived from the choices
 * (domain/whatsappLimits.ts `layoutOf`): up to 3 short labels without descriptions are
 * reply buttons; anything else is a list (rows with an optional description, grouped by
 * `section`). The same ids are used on every channel.
 */
export interface OutboundOption {
  optionId: string;
  label: string;
  description?: string;
  section?: string;
}

/**
 * Structured parts beyond body text and options (Change 16, UI-2). Channel-neutral, but
 * limited to what WhatsApp can render (domain/whatsappLimits.ts). A location is sent as a
 * separate location message on WhatsApp.
 */
export interface MessageParts {
  header?: { type: 'IMAGE'; url: string; alt: string } | { type: 'TEXT'; text: string };
  footer?: string;
  location?: { name: string; address: string; latitude: number; longitude: number };
  ctaUrl?: { label: string; url: string };
  /** The list's open button ("Choose a store"); lists only. */
  listButton?: string;
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
  parts?: MessageParts;
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
