/**
 * Persistence ports for M4: customers, storefront intents, handshake tokens,
 * conversations, messages, recommendations, commerce events and webhook receipts
 * (docs/04_DATA_MODEL.md §6, §11–§14, §17, §18.1, §18.3, §21). All tenant-scoped
 * methods take the brand of the verified principal or validated token.
 */
import type {
  AgentRuntimeName,
  AiAction,
  DecisionSource,
  GuardrailStatus,
  IntentStage,
  IntentStrength,
  IntentType,
} from '../domain/ai.js';
import type { Channel } from '../domain/channels.js';
import type { AiWindow, MessageKind } from '../domain/conversationPolicy.js';
import type { CommerceEventType } from '../domain/events.js';
import type { FollowUpPriority, FollowUpStatus } from '../domain/followUpPolicy.js';
import type { IntentSignals, WebEventType } from '../domain/intentClassification.js';
import type { TokenRejection } from '../domain/intentToken.js';
import type { PendingProposal } from '../domain/guardrail.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Customer location for store search (docs/04 §6): rounded to 2 dp, or a store locality. */
export interface CustomerLocation {
  latitude: number;
  longitude: number;
  source: 'SHARED' | 'LOCALITY';
  locality: string | null;
  at: string;
}

export type ConsentState = 'OPTED_IN' | 'NOT_OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';

export interface ChannelIdentity {
  channel: Channel;
  externalRef: string;
}

export interface CustomerRecord {
  customerId: string;
  brandId: string;
  shopifyCustomerId: string | null;
  channelIdentities: ChannelIdentity[];
  consentState: ConsentState;
  optedOutAt: string | null;
  /** Safe label for the Brand Console, e.g. "sim:customer_01". Never a phone number. */
  displayRef: string;
  lastProactiveAt: string | null;
  lastLocation: CustomerLocation | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRepository {
  get(brandId: string, customerId: string): Promise<CustomerRecord | null>;
  findByIdentity(brandId: string, identity: ChannelIdentity): Promise<CustomerRecord | null>;
  /** The customer for this identity, created atomically if it does not exist yet. */
  findOrCreateByIdentity(
    brandId: string,
    identity: ChannelIdentity,
    create: { consentState: ConsentState; shopifyCustomerId: string | null; displayRef: string },
    now: string,
  ): Promise<{ customer: CustomerRecord; created: boolean }>;
  update(
    brandId: string,
    customerId: string,
    patch: Partial<Pick<CustomerRecord, 'consentState' | 'optedOutAt' | 'lastProactiveAt' | 'lastLocation'>>,
  ): Promise<void>;
}

export interface VisitorLink {
  customerId: string;
  linkSource: 'HANDSHAKE' | 'SIGNED_IN_SHOPPER';
  linkedAt: string;
}

/** webVisitors/{sha256(visitor_id)}: the raw visitor_id is never stored. */
export interface VisitorLinkRepository {
  get(brandId: string, visitorHash: string): Promise<VisitorLink | null>;
  link(brandId: string, visitorHash: string, link: VisitorLink): Promise<void>;
}

export interface FollowUpState {
  decision: 'FOLLOW_UP_ELIGIBLE' | 'FOLLOW_UP_NOT_ELIGIBLE';
  reason: string;
  evaluatedAt: string;
  dueAt: string | null;
  priority: FollowUpPriority | null;
  status: FollowUpStatus;
  messageKind: MessageKind | null;
  templateName: string | null;
  sentMessageId: string | null;
  conversationId: string | null;
  claimedAt: string | null;
  sentAt: string | null;
}

export type IntentStatus = 'ACTIVE' | 'ABANDONED' | 'CONVERTED' | 'EXPIRED';

export interface IntentRecord {
  intentId: string;
  brandId: string;
  customerId: string | null;
  webSessionId: string;
  visitorHash: string | null;
  source: 'WEBSITE';
  stage: IntentStage;
  strength: IntentStrength;
  type: IntentType;
  confidence: number;
  productId: string | null;
  variantId: string | null;
  matchedCategory: string | null;
  signals: IntentSignals;
  lastEvent: WebEventType;
  lastEventAt: string;
  eventCount: number;
  detectedAt: string;
  updatedAt: string;
  status: IntentStatus;
  tokenConsumedAt: string | null;
  followUp: FollowUpState | null;
  /** Recent client_event_ids already applied (bounded), so a replay never re-applies an event. */
  processedEventIds: string[];
}

export interface IntentRepository {
  get(brandId: string, intentId: string): Promise<IntentRecord | null>;
  /** Read-modify-write in one transaction; `fn` returning null writes nothing. */
  update(
    brandId: string,
    intentId: string,
    fn: (current: IntentRecord | null) => IntentRecord | null,
  ): Promise<IntentRecord | null>;
  /** Newest first. */
  list(brandId: string, limit: number): Promise<IntentRecord[]>;
  listByCustomer(brandId: string, customerId: string): Promise<IntentRecord[]>;
  listByWebSessions(brandId: string, webSessionIds: string[]): Promise<IntentRecord[]>;
  /** ACTIVE intents with last_event_at ≤ `beforeIso`. */
  listIdleActive(brandId: string, beforeIso: string): Promise<IntentRecord[]>;
  /** follow_up.status = SCHEDULED and follow_up.due_at ≤ `nowIso`. */
  listDueFollowUps(brandId: string, nowIso: string): Promise<IntentRecord[]>;
  /** M6: follow_up.sent_at in [fromIso, toIso) (journeys engaged by a proactive message). */
  listFollowUpsSentBetween(brandId: string, fromIso: string, toIso: string): Promise<IntentRecord[]>;
}

export interface IntentTokenRecord {
  tokenHash: string;
  brandId: string;
  intentId: string;
  webSessionId: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedByCustomerId: string | null;
}

export interface IntentTokenRepository {
  create(token: IntentTokenRecord): Promise<void>;
  countIssuedSince(brandId: string, webSessionId: string, sinceIso: string): Promise<number>;
  /**
   * In ONE transaction: validate the token (`check`), mark it consumed, and bind the
   * intent to the customer (customer_id, token_consumed_at). Returns the bound intent.
   */
  consumeAndBind(
    tokenHash: string,
    brandId: string,
    customerId: string,
    now: Date,
    check: (token: IntentTokenRecord | null) => TokenRejection | null,
  ): Promise<{ ok: true; intent: IntentRecord | null } | { ok: false; reason: TokenRejection }>;
}

export interface ConversationRecord {
  conversationId: string;
  brandId: string;
  customerId: string;
  channel: Channel;
  status: 'OPEN';
  currentIntentId: string | null;
  startedAt: string;
  updatedAt: string;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  humanHandoff: boolean;
  aiWindow: AiWindow;
  /** M5: the hold currently offered to the customer (docs/04 §12). */
  pendingProposal: PendingProposal | null;
  /** M6: when the conversation was handed to a person (null when automated). */
  handoffAt: string | null;
}

export type MessageOrigin =
  | 'CUSTOMER'
  | 'AUTOMATED_REPLY'
  | 'PROACTIVE_FOLLOW_UP'
  /** M6: a store update about the customer's reservation (Change 13, F4). */
  | 'RESERVATION_UPDATE'
  /** M6: a Brand Admin replying as a person during a handoff (Change 13, F7). */
  | 'HUMAN_AGENT';

export interface MessageRecord {
  messageId: string;
  brandId: string;
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  messageType: 'TEXT' | 'LOCATION' | 'INTERACTIVE_REPLY' | 'INTERACTIVE' | 'TEMPLATE';
  /** Stored text: token removed, truncated to 2,000 characters. */
  text: string | null;
  options: { optionId: string; label: string }[] | null;
  location: { latitude: number; longitude: number } | null;
  origin: MessageOrigin;
  messageKind: MessageKind | null;
  templateName: string | null;
  externalMessageId: string | null;
  deliveryStatus: 'RECEIVED' | 'SENT' | 'DELIVERED' | 'FAILED';
  timestamp: string;
}

export interface ConversationRepository {
  get(brandId: string, conversationId: string): Promise<ConversationRecord | null>;
  findForCustomer(brandId: string, customerId: string, channel: Channel): Promise<ConversationRecord | null>;
  create(conversation: ConversationRecord): Promise<void>;
  update(
    brandId: string,
    conversationId: string,
    patch: Partial<
      Pick<
        ConversationRecord,
        | 'currentIntentId'
        | 'lastInboundAt'
        | 'lastMessageAt'
        | 'humanHandoff'
        | 'updatedAt'
        | 'pendingProposal'
        | 'handoffAt'
      >
    >,
  ): Promise<void>;
  /** Newest activity first. */
  list(brandId: string, limit: number): Promise<ConversationRecord[]>;
  /** Firestore-backed per-conversation AI limit (docs/07 §17), in one transaction. */
  consumeAiWindow(
    brandId: string,
    conversationId: string,
    next: (window: AiWindow) => { allowed: boolean; sendWaitNotice: boolean; next: AiWindow },
  ): Promise<{ allowed: boolean; sendWaitNotice: boolean }>;
  addMessage(message: MessageRecord): Promise<void>;
  /** Oldest first; with `afterMessageId`, only messages after it. */
  listMessages(brandId: string, conversationId: string, afterMessageId?: string): Promise<MessageRecord[]>;
}

export interface RecommendationRecord {
  recommendationId: string;
  brandId: string;
  customerId: string;
  conversationId: string;
  intentId: string | null;
  action: AiAction;
  targetStoreId: string | null;
  targetVariantId: string | null;
  confidence: number;
  rationaleSummary: string;
  evidenceReferences: string[];
  runtime: AgentRuntimeName;
  decisionSource: DecisionSource;
  guardrailStatus: GuardrailStatus;
  /** M5: the block code when BLOCKED. */
  guardrailReason: string | null;
  proposedAt: string;
  /** M5: "Why Qwikspot did this" (docs/04 §14); PII-free JSON. */
  trace: DecisionTrace | null;
}

export interface DecisionTrace {
  context_hash: string;
  context_summary: { [key: string]: JsonValue };
  tool_calls: {
    call_id: string;
    tool: string;
    kind: 'READ' | 'WRITE';
    phase: 'DECIDE' | 'EXECUTE';
    input: { [key: string]: JsonValue };
    output_summary: { [key: string]: JsonValue };
    status: 'EXECUTED' | 'BLOCKED' | 'FAILED';
    reason_code: string | null;
    duration_ms: number;
  }[];
  eligible: { store_id: string; store_name: string; distance_km: number; variant_id: string }[];
  excluded: { store_id: string; store_name: string; reason: string; distance_km: number | null; variant_id: string }[];
  guardrail: { status: GuardrailStatus; reason_code: string | null; checked: string | null };
  executed_action: { tool: string; status: string; reason_code: string | null; reservation_id: string | null } | null;
  repaired: boolean;
  fallback_reason: string | null;
}

export interface RecommendationRepository {
  create(recommendation: RecommendationRecord): Promise<void>;
  get(brandId: string, recommendationId: string): Promise<RecommendationRecord | null>;
  /** Oldest first. */
  listByConversation(brandId: string, conversationId: string): Promise<RecommendationRecord[]>;
  /** M6: oldest first. */
  listByIntent(brandId: string, intentId: string): Promise<RecommendationRecord[]>;
  /** M6: proposed_at in [fromIso, toIso). */
  listProposedBetween(brandId: string, fromIso: string, toIso: string): Promise<RecommendationRecord[]>;
}

export interface CommerceEventRecord {
  eventId: string;
  brandId: string;
  customerId: string | null;
  webSessionId: string | null;
  eventType: CommerceEventType;
  source: 'WEBSITE' | 'SIMULATOR' | 'WHATSAPP' | 'SHOPIFY' | 'QWIKSPOT';
  entityReference: string | null;
  /** Small, PII-free JSON payload (e.g. product_id, matched_category, reason, unmet_demand). */
  payload: { [key: string]: JsonValue };
  timestamp: string;
  idempotencyKey: string;
}

export interface CommerceEventRepository {
  /** Create-if-absent by event ID; false when it already existed (a replay). */
  record(event: CommerceEventRecord): Promise<boolean>;
  listByWebSession(brandId: string, webSessionId: string): Promise<CommerceEventRecord[]>;
}

export interface ReceiptMeta {
  brandId: string;
  provider: 'SHOPIFY' | 'WHATSAPP' | 'SIMULATOR';
  eventType: string;
  externalEventId: string;
}

/** webhookReceipts (docs/03 §16.3): create-if-absent; PROCESSING / PROCESSED → duplicate. */
export interface WebhookReceiptRepository {
  begin(
    key: string,
    meta: ReceiptMeta,
    now: Date,
  ): Promise<{ state: 'NEW' } | { state: 'DUPLICATE'; status: 'PROCESSING' | 'PROCESSED'; result: unknown }>;
  complete(key: string, result: unknown): Promise<void>;
  fail(key: string): Promise<void>;
  /** M7: the receipt's current state, for a replay that arrives while the first delivery is processing. */
  peek(key: string): Promise<{ status: 'PROCESSING' | 'PROCESSED' | 'FAILED'; result: unknown } | null>;
}
