/** Response shapes of the conversation routes (docs/06 §14.2, docs/11 §4). */

export type Origin = 'CUSTOMER' | 'AUTOMATED_REPLY' | 'PROACTIVE_FOLLOW_UP' | 'RESERVATION_UPDATE' | 'HUMAN_AGENT';

export interface ChatOption {
  option_id: string;
  label: string;
  /** List rows only (Change 16). */
  description?: string;
  section?: string;
}

/** Structured parts of an outbound message (Change 16): what WhatsApp can render. */
export interface ChatParts {
  header: { type: 'IMAGE'; url: string; alt: string } | { type: 'TEXT'; text: string } | null;
  footer: string | null;
  location: { name: string; address: string; latitude: number; longitude: number } | null;
  cta_url: { label: string; url: string } | null;
  list_button: string | null;
}

export interface ChatMessage {
  message_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  message_type: string;
  text: string | null;
  options: ChatOption[] | null;
  location: { latitude: number; longitude: number } | null;
  /** Absent on messages written before UI-2. */
  parts?: ChatParts | null;
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
  /** M6: when a person took over (null while the assistant owns the conversation). */
  handoff_at?: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  intent: IntentSummary | null;
  /** UI-3: generated demo history (Change 16). */
  demo_history?: boolean;
}

/** UI-3: a recorded outcome of the conversation's journey (docs/04 §16). */
export interface JourneyOutcome {
  purchase_type: 'ONLINE' | 'OFFLINE' | 'ALTERNATIVE' | 'NONE';
  evidence: 'RESERVATION_COMPLETED' | 'ORDER' | 'WINDOW_CLOSED';
  channel: string | null;
  store_id: string | null;
  store_name: string | null;
  reservation_id: string | null;
  value: number;
  currency: string | null;
  timestamp: string;
  /** L2-Shopify: the order behind the outcome was cancelled; it no longer counts as a sale. */
  cancelled_at?: string | null;
}

/** UI-3: one status change of a reservation, derived from its timestamps. */
export interface StatusStep {
  status: string;
  at: string;
  by?: 'CUSTOMER' | 'RETAILER' | 'SYSTEM' | null;
  reason?: string | null;
}

export interface ConversationDetail extends ConversationRow {
  brand_display_name: string;
  web_events: { event_type: string; at: string; details: Record<string, string | number | null> }[];
  messages: ChatMessage[];
  recommendations: Recommendation[];
  /** UI-3: the journey's recorded outcome(s). Absent on older backends. */
  outcomes?: JourneyOutcome[];
}

/** "Why Qwikspot did this" (docs/04 §14 trace; docs/11 §4). */
export interface DecisionTrace {
  context_hash: string;
  context_summary: Record<string, unknown>;
  tool_calls: {
    call_id: string;
    tool: string;
    kind: 'READ' | 'WRITE';
    phase: 'DECIDE' | 'EXECUTE';
    input: Record<string, unknown>;
    output_summary: Record<string, unknown>;
    status: 'EXECUTED' | 'BLOCKED' | 'FAILED';
    reason_code: string | null;
    duration_ms: number;
  }[];
  eligible: { store_id: string; store_name: string; distance_km: number; variant_id: string }[];
  excluded: { store_id: string; store_name: string; reason: string; distance_km: number | null; variant_id: string }[];
  guardrail: { status: string; reason_code: string | null; checked: string | null };
  executed_action: { tool: string; status: string; reason_code: string | null; reservation_id: string | null } | null;
  repaired: boolean;
  fallback_reason: string | null;
}

export interface Recommendation {
  recommendation_id: string;
  action: string;
  runtime: string;
  decision_source: string;
  guardrail_status: string;
  guardrail_reason?: string | null;
  rationale_summary: string;
  target_store_id?: string | null;
  target_variant_id?: string | null;
  proposed_at: string;
  trace?: DecisionTrace | null;
  reservation?: {
    reservation_id: string;
    status: string;
    store_id: string;
    store_name: string;
    pickup_code: string;
    expires_at: string;
    quantity?: number;
    product_title?: string | null;
    variant_title?: string | null;
    status_history?: StatusStep[];
  } | null;
}

export interface ReservationRow {
  reservation_id: string;
  store_id: string;
  store_name: string;
  product_title: string | null;
  variant_title: string | null;
  sku: string;
  quantity: number;
  status: string;
  active: boolean;
  customer_display: string;
  created_at: string;
  expires_at: string;
  store_timezone?: string;
  cancelled_at?: string | null;
  cancelled_by?: 'CUSTOMER' | 'RETAILER' | 'SYSTEM' | null;
  cancel_reason?: string | null;
  completed_at?: string | null;
  /** UI-3, brand rows only. */
  conversation_id?: string | null;
  image_url?: string | null;
  demo_history?: boolean;
}

/** Store refusal reasons in words (docs/04 §15). */
export const REFUSAL_TEXT: Record<string, string> = {
  NOT_ACTUALLY_IN_STOCK: 'not actually in stock',
  DAMAGED: 'damaged',
  STORE_CLOSING_EARLY: 'store closing early',
  OTHER: 'other reason',
};

/** Plain words for store exclusions and guardrail blocks. */
export const EXCLUSION_TEXT: Record<string, string> = {
  INACTIVE: 'store inactive',
  RESERVATIONS_DISABLED: 'no reservations / pickup',
  TOO_FAR: 'too far',
  CLOSED: 'closed now',
  OUT_OF_STOCK: 'out of stock',
};

export const GUARDRAIL_TEXT: Record<string, string> = {
  OUT_OF_STOCK: 'Blocked: out of stock on fresh data.',
  STORE_CLOSED: 'Blocked: the store is closed now.',
  NOT_ELIGIBLE:
    'Blocked: the store or request is not eligible (inactive, reservations off, too far or over the limit).',
  SCOPE_VIOLATION: "Blocked: outside this customer's or brand's scope.",
  AMBIGUOUS: 'Blocked: nothing clear to act on — the customer is asked first.',
};

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
