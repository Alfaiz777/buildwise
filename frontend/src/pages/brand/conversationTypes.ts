/** Response shapes of the conversation routes (docs/06 §14.2, docs/11 §4). */

export type Origin = 'CUSTOMER' | 'AUTOMATED_REPLY' | 'PROACTIVE_FOLLOW_UP';

export interface ChatMessage {
  message_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  message_type: string;
  text: string | null;
  options: { option_id: string; label: string }[] | null;
  location: { latitude: number; longitude: number } | null;
  origin: Origin;
  message_kind: 'SESSION' | 'TEMPLATE' | null;
  template_name: string | null;
  delivery_status: string;
  timestamp: string;
}

export interface FollowUp {
  decision: 'FOLLOW_UP_ELIGIBLE' | 'FOLLOW_UP_NOT_ELIGIBLE';
  reason: string;
  status: string;
  evaluated_at: string;
  due_at: string | null;
  priority: 'NORMAL' | 'HIGH' | null;
  message_kind: 'SESSION' | 'TEMPLATE' | null;
  template_name: string | null;
  sent_at: string | null;
}

export interface IntentSummary {
  intent_id: string;
  who: string;
  anonymous: boolean;
  intent_stage: string;
  intent_strength: string;
  intent_type: string;
  status: string;
  product_title: string | null;
  variant_title: string | null;
  matched_category: string | null;
  last_event: string;
  last_event_at: string;
  detected_at: string;
  token_consumed: boolean;
  follow_up: FollowUp | null;
}

export interface ConversationRow {
  conversation_id: string;
  customer_ref: string;
  channel: string;
  status: string;
  human_handoff: boolean;
  last_message_at: string | null;
  last_inbound_at: string | null;
  intent: IntentSummary | null;
}

export interface ConversationDetail extends ConversationRow {
  brand_display_name: string;
  web_events: { event_type: string; at: string; details: Record<string, string | number | null> }[];
  messages: ChatMessage[];
  recommendations: {
    recommendation_id: string;
    action: string;
    runtime: string;
    decision_source: string;
    guardrail_status: string;
    rationale_summary: string;
    proposed_at: string;
  }[];
}

export interface SimulatorResponse {
  conversation_id: string;
  inbound_message_id: string;
  outbound_messages: ChatMessage[];
  decision: {
    recommendation_id: string | null;
    action: string;
    guardrail_status: string | null;
    runtime: string;
    decision_source: string | null;
    executed_action: null;
    policy_reason: string | null;
  };
}

/** Plain-words labels for the "Intent & follow-up" panel. */
export const REASON_TEXT: Record<string, string> = {
  ELIGIBLE: 'Eligible for a follow-up.',
  WEAK_INTENT: 'Intent too weak for a follow-up (browsing only).',
  INTENT_TYPE_DISABLED: 'The brand has switched off follow-ups for this kind of intent.',
  CUSTOMER_NOT_REACHABLE: 'Anonymous visitor: no known, reachable customer to message.',
  CHANNEL_DISABLED: "The customer's channel is not enabled.",
  OPTED_OUT: 'The customer opted out.',
  NO_CONSENT: 'The customer has not opted in to messages.',
  HUMAN_HANDOFF: 'A person is handling this conversation.',
  ALREADY_CONVERTED: 'The customer already ordered.',
  ALREADY_FOLLOWED_UP: 'Already followed up once for this intent.',
  FREQUENCY_LIMIT: 'This customer already received a proactive message in the last 24 hours.',
  CUSTOMER_ALREADY_IN_CONVERSATION: 'The customer is already chatting with the brand.',
};

export const EVENT_TEXT: Record<string, string> = {
  STOREFRONT_VISIT: 'Visited the store',
  SEARCH: 'Searched',
  PRODUCT_VIEW: 'Viewed a product',
  PRODUCT_DETAIL_VIEW: 'Opened product details',
  VARIANT_SELECTED: 'Chose a size / variant',
  ADD_TO_CART: 'Added to cart',
  CHECKOUT_STARTED: 'Started checkout',
  WHATSAPP_CLICK: 'Clicked the WhatsApp button',
  ORDER_CREATED: 'Placed an order',
  FOLLOW_UP_SCHEDULED: 'Follow-up scheduled',
  FOLLOW_UP_SUPPRESSED: 'Follow-up suppressed',
  FOLLOW_UP_SENT: 'Follow-up sent',
};

export const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

/** "in 1m 20s" / "due now" for a future ISO time. */
export function countdown(dueAt: string, now: number): string {
  const ms = new Date(dueAt).getTime() - now;
  if (ms <= 0) return 'due now';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `in ${m}m ${s % 60}s` : `in ${s}s`;
}

/** The simulator prefill carried in the URL fragment (never the query string). */
export function parseSimulatorFragment(hash: string): { text: string | null; customer: string | null } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return { text: params.get('text'), customer: params.get('customer') };
}
