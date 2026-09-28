/** Canonical CommerceEvent (docs/04_DATA_MODEL.md §17). */

export const COMMERCE_EVENT_TYPES = [
  'PRODUCT_VIEW',
  'PRODUCT_DETAIL_VIEW',
  'ADD_TO_CART',
  'CHECKOUT_STARTED',
  'WHATSAPP_CLICK',
  'ORDER_CREATED',
  'CONVERSATION_STARTED',
  'MESSAGE_RECEIVED',
  'MESSAGE_SENT',
  'AI_DECISION',
  'STORE_RECOMMENDATION',
  'RESERVATION_CREATED',
  'RESERVATION_CONFIRMED',
  'PICKUP_COMPLETED',
  'ONLINE_PURCHASE',
  'OFFLINE_PURCHASE',
  'HUMAN_HANDOFF',
] as const;
export type CommerceEventType = (typeof COMMERCE_EVENT_TYPES)[number];

export interface CommerceEvent {
  eventId: string;
  brandId: string;
  customerId: string | null;
  webSessionId: string | null;
  eventType: CommerceEventType;
  source: string;
  entityReference: string | null;
  eventPayloadReference: string | null;
  /** ISO-8601 */
  timestamp: string;
  idempotencyKey: string;
}
