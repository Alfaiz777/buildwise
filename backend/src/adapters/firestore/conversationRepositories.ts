import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Channel } from '../../domain/channels.js';
import type { AiWindow } from '../../domain/conversationPolicy.js';
import type {
  ChannelIdentity,
  CommerceEventRecord,
  CommerceEventRepository,
  ConsentState,
  ConversationRecord,
  ConversationRepository,
  CustomerLocation,
  CustomerRecord,
  CustomerRepository,
  FollowUpState,
  IntentRecord,
  IntentRepository,
  IntentTokenRecord,
  IntentTokenRepository,
  MessageRecord,
  RecommendationRecord,
  RecommendationRepository,
  ReceiptMeta,
  VisitorLink,
  VisitorLinkRepository,
  WebhookReceiptRepository,
} from '../../ports/conversationRepositories.js';
import type { TokenRejection } from '../../domain/intentToken.js';
import type { PendingProposal } from '../../domain/guardrail.js';
import { newId } from '../../lib/ids.js';
import type { MessageParts, OutboundOption } from '../../ports/messaging.js';

/**
 * Firestore implementations of the M4 ports (docs/04_DATA_MODEL.md §21). Timestamps are
 * stored as ISO-8601 strings so that range queries (due follow-ups, idle intents) are
 * simple string comparisons. Documents are mapped field by field (snake_case ⇄ records).
 */

const brandCol = (db: Firestore, brandId: string, name: string) =>
  db.collection('brands').doc(brandId).collection(name);
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const identityKey = (i: ChannelIdentity) => `${i.channel}:${i.externalRef}`;

// ---------------------------------------------------------------------------- customers

const locationFromDoc = (d: FirebaseFirestore.DocumentData | null | undefined): CustomerLocation | null =>
  d && typeof d.latitude === 'number' && typeof d.longitude === 'number'
    ? { latitude: d.latitude, longitude: d.longitude, source: d.source, locality: d.locality ?? null, at: d.at }
    : null;

const toCustomer = (id: string, d: FirebaseFirestore.DocumentData): CustomerRecord => ({
  customerId: id,
  brandId: d.brand_id,
  shopifyCustomerId: d.shopify_customer_id ?? null,
  channelIdentities: (d.channel_identities ?? []).map((i: { channel: Channel; external_ref: string }) => ({
    channel: i.channel,
    externalRef: i.external_ref,
  })),
  consentState: (d.consent_state ?? 'UNKNOWN') as ConsentState,
  optedOutAt: d.opted_out_at ?? null,
  displayRef: d.display_ref ?? 'customer',
  lastProactiveAt: d.last_proactive_at ?? null,
  lastLocation: locationFromDoc(d.last_location),
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

export class FirestoreCustomerRepository implements CustomerRepository {
  constructor(private readonly db: Firestore) {}

  async get(brandId: string, customerId: string) {
    const snap = await brandCol(this.db, brandId, 'customers').doc(customerId).get();
    return snap.exists ? toCustomer(snap.id, snap.data()!) : null;
  }

  async findByIdentity(brandId: string, identity: ChannelIdentity) {
    const guard = await brandCol(this.db, brandId, 'channelIdentities')
      .doc(sha(identityKey(identity)))
      .get();
    return guard.exists ? this.get(brandId, guard.get('customer_id')) : null;
  }

  async findOrCreateByIdentity(
    brandId: string,
    identity: ChannelIdentity,
    create: { consentState: ConsentState; shopifyCustomerId: string | null; displayRef: string },
    now: string,
  ) {
    const guardRef = brandCol(this.db, brandId, 'channelIdentities').doc(sha(identityKey(identity)));
    return this.db.runTransaction(async (tx) => {
      const guard = await tx.get(guardRef);
      if (guard.exists) {
        const snap = await tx.get(brandCol(this.db, brandId, 'customers').doc(guard.get('customer_id')));
        return { customer: toCustomer(snap.id, snap.data()!), created: false };
      }
      const customerId = newId('cus');
      const record: CustomerRecord = {
        customerId,
        brandId,
        shopifyCustomerId: create.shopifyCustomerId,
        channelIdentities: [identity],
        consentState: create.consentState,
        optedOutAt: null,
        displayRef: create.displayRef,
        lastProactiveAt: null,
        lastLocation: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(guardRef, { customer_id: customerId, channel: identity.channel, brand_id: brandId });
      tx.create(brandCol(this.db, brandId, 'customers').doc(customerId), {
        customer_id: customerId,
        brand_id: brandId,
        shopify_customer_id: record.shopifyCustomerId,
        channel_identities: [{ channel: identity.channel, external_ref: identity.externalRef }],
        identity_keys: [identityKey(identity)],
        consent_state: record.consentState,
        opted_out_at: null,
        display_ref: record.displayRef,
        last_proactive_at: null,
        lifecycle_stage: null,
        preferred_channel: identity.channel,
        created_at: now,
        updated_at: now,
      });
      return { customer: record, created: true };
    });
  }

  async update(
    brandId: string,
    customerId: string,
    patch: Partial<Pick<CustomerRecord, 'consentState' | 'optedOutAt' | 'lastProactiveAt' | 'lastLocation'>>,
  ) {
    const doc: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.consentState !== undefined) doc.consent_state = patch.consentState;
    if (patch.optedOutAt !== undefined) doc.opted_out_at = patch.optedOutAt;
    if (patch.lastProactiveAt !== undefined) doc.last_proactive_at = patch.lastProactiveAt;
    if (patch.lastLocation !== undefined) doc.last_location = patch.lastLocation ? { ...patch.lastLocation } : null;
    await brandCol(this.db, brandId, 'customers').doc(customerId).update(doc);
  }
}

export class FirestoreVisitorLinkRepository implements VisitorLinkRepository {
  constructor(private readonly db: Firestore) {}

  async get(brandId: string, visitorHash: string): Promise<VisitorLink | null> {
    const snap = await brandCol(this.db, brandId, 'webVisitors').doc(visitorHash).get();
    return snap.exists
      ? { customerId: snap.get('customer_id'), linkSource: snap.get('link_source'), linkedAt: snap.get('linked_at') }
      : null;
  }

  async link(brandId: string, visitorHash: string, link: VisitorLink) {
    await brandCol(this.db, brandId, 'webVisitors')
      .doc(visitorHash)
      .set({ customer_id: link.customerId, link_source: link.linkSource, linked_at: link.linkedAt });
  }
}

// ---------------------------------------------------------------------------- intents

const followUpToDoc = (f: FollowUpState | null) =>
  f && {
    decision: f.decision,
    reason: f.reason,
    evaluated_at: f.evaluatedAt,
    due_at: f.dueAt,
    priority: f.priority,
    status: f.status,
    message_kind: f.messageKind,
    template_name: f.templateName,
    sent_message_id: f.sentMessageId,
    conversation_id: f.conversationId,
    claimed_at: f.claimedAt,
    sent_at: f.sentAt,
  };

const followUpFromDoc = (d: FirebaseFirestore.DocumentData | null | undefined): FollowUpState | null =>
  d
    ? {
        decision: d.decision,
        reason: d.reason,
        evaluatedAt: d.evaluated_at,
        dueAt: d.due_at ?? null,
        priority: d.priority ?? null,
        status: d.status,
        messageKind: d.message_kind ?? null,
        templateName: d.template_name ?? null,
        sentMessageId: d.sent_message_id ?? null,
        conversationId: d.conversation_id ?? null,
        claimedAt: d.claimed_at ?? null,
        sentAt: d.sent_at ?? null,
      }
    : null;

export const intentToDoc = (i: IntentRecord) => ({
  intent_id: i.intentId,
  brand_id: i.brandId,
  customer_id: i.customerId,
  web_session_id: i.webSessionId,
  visitor_hash: i.visitorHash,
  source: i.source,
  intent_stage: i.stage,
  intent_strength: i.strength,
  intent_type: i.type,
  confidence: i.confidence,
  product_id: i.productId,
  product_variant_id: i.variantId,
  matched_category: i.matchedCategory,
  signals: {
    product_views: i.signals.productViews,
    detail_views: i.signals.detailViews,
    variant_selected: i.signals.variantSelected,
    whatsapp_clicks: i.signals.whatsappClicks,
    store_need_clicked_at: i.signals.storeNeedClickedAt,
    chat_clicked_at: i.signals.chatClickedAt,
  },
  last_event: i.lastEvent,
  last_event_at: i.lastEventAt,
  event_count: i.eventCount,
  detected_at: i.detectedAt,
  updated_at: i.updatedAt,
  status: i.status,
  token_consumed_at: i.tokenConsumedAt,
  follow_up: followUpToDoc(i.followUp),
  processed_event_ids: i.processedEventIds,
});

export const intentFromDoc = (id: string, d: FirebaseFirestore.DocumentData): IntentRecord => ({
  intentId: id,
  brandId: d.brand_id,
  customerId: d.customer_id ?? null,
  webSessionId: d.web_session_id,
  visitorHash: d.visitor_hash ?? null,
  source: 'WEBSITE',
  stage: d.intent_stage,
  strength: d.intent_strength,
  type: d.intent_type,
  confidence: d.confidence ?? 1,
  productId: d.product_id ?? null,
  variantId: d.product_variant_id ?? null,
  matchedCategory: d.matched_category ?? null,
  signals: {
    productViews: d.signals?.product_views ?? {},
    detailViews: d.signals?.detail_views ?? {},
    variantSelected: d.signals?.variant_selected ?? [],
    whatsappClicks: d.signals?.whatsapp_clicks ?? 0,
    storeNeedClickedAt: d.signals?.store_need_clicked_at ?? null,
    chatClickedAt: d.signals?.chat_clicked_at ?? null,
  },
  lastEvent: d.last_event,
  lastEventAt: d.last_event_at,
  eventCount: d.event_count ?? 0,
  detectedAt: d.detected_at,
  updatedAt: d.updated_at,
  status: d.status,
  tokenConsumedAt: d.token_consumed_at ?? null,
  followUp: followUpFromDoc(d.follow_up),
  processedEventIds: d.processed_event_ids ?? [],
});

export class FirestoreIntentRepository implements IntentRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return brandCol(this.db, brandId, 'customerIntents');
  }

  async get(brandId: string, intentId: string) {
    const snap = await this.col(brandId).doc(intentId).get();
    return snap.exists ? intentFromDoc(snap.id, snap.data()!) : null;
  }

  async update(brandId: string, intentId: string, fn: (current: IntentRecord | null) => IntentRecord | null) {
    const ref = this.col(brandId).doc(intentId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = fn(snap.exists ? intentFromDoc(snap.id, snap.data()!) : null);
      if (next) tx.set(ref, intentToDoc(next));
      return next;
    });
  }

  private async query(q: FirebaseFirestore.Query) {
    const snap = await q.get();
    return snap.docs.map((d) => intentFromDoc(d.id, d.data()));
  }

  list(brandId: string, limit: number) {
    return this.query(this.col(brandId).orderBy('updated_at', 'desc').limit(limit));
  }

  listByCustomer(brandId: string, customerId: string) {
    return this.query(this.col(brandId).where('customer_id', '==', customerId));
  }

  async listByWebSessions(brandId: string, webSessionIds: string[]) {
    if (webSessionIds.length === 0) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < webSessionIds.length; i += 30) chunks.push(webSessionIds.slice(i, i + 30));
    return (
      await Promise.all(chunks.map((c) => this.query(this.col(brandId).where('web_session_id', 'in', c))))
    ).flat();
  }

  listIdleActive(brandId: string, beforeIso: string) {
    return this.query(this.col(brandId).where('status', '==', 'ACTIVE').where('last_event_at', '<=', beforeIso));
  }

  listDueFollowUps(brandId: string, nowIso: string) {
    return this.query(
      this.col(brandId).where('follow_up.status', '==', 'SCHEDULED').where('follow_up.due_at', '<=', nowIso),
    );
  }

  listFollowUpsSentBetween(brandId: string, fromIso: string, toIso: string) {
    return this.query(
      this.col(brandId).where('follow_up.sent_at', '>=', fromIso).where('follow_up.sent_at', '<', toIso),
    );
  }
}

// ---------------------------------------------------------------------------- intent tokens

const tokenFromDoc = (d: FirebaseFirestore.DocumentData): IntentTokenRecord => ({
  tokenHash: d.token_hash,
  brandId: d.brand_id,
  intentId: d.intent_id,
  webSessionId: d.web_session_id,
  issuedAt: d.issued_at,
  expiresAt: d.expires_at,
  consumedAt: d.consumed_at ?? null,
  consumedByCustomerId: d.consumed_by_customer_id ?? null,
});

export class FirestoreIntentTokenRepository implements IntentTokenRepository {
  constructor(private readonly db: Firestore) {}

  async create(t: IntentTokenRecord) {
    await this.db.collection('intentTokens').doc(t.tokenHash).create({
      token_hash: t.tokenHash,
      brand_id: t.brandId,
      intent_id: t.intentId,
      web_session_id: t.webSessionId,
      issued_at: t.issuedAt,
      expires_at: t.expiresAt,
      consumed_at: null,
      consumed_by_customer_id: null,
    });
  }

  async countIssuedSince(brandId: string, webSessionId: string, sinceIso: string) {
    const snap = await this.db
      .collection('intentTokens')
      .where('web_session_id', '==', webSessionId)
      .where('issued_at', '>=', sinceIso)
      .get();
    return snap.docs.filter((d) => d.get('brand_id') === brandId).length;
  }

  async consumeAndBind(
    tokenHash: string,
    brandId: string,
    customerId: string,
    now: Date,
    check: (token: IntentTokenRecord | null) => TokenRejection | null,
  ): Promise<{ ok: true; intent: IntentRecord | null } | { ok: false; reason: TokenRejection }> {
    const tokenRef = this.db.collection('intentTokens').doc(tokenHash);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(tokenRef);
      const token = snap.exists ? tokenFromDoc(snap.data()!) : null;
      const reason = check(token);
      if (reason) return { ok: false as const, reason };
      const intentRef = brandCol(this.db, brandId, 'customerIntents').doc(token!.intentId);
      const intentSnap = await tx.get(intentRef);
      const at = now.toISOString();
      tx.update(tokenRef, { consumed_at: at, consumed_by_customer_id: customerId });
      if (!intentSnap.exists) return { ok: true as const, intent: null };
      const intent = {
        ...intentFromDoc(intentSnap.id, intentSnap.data()!),
        customerId,
        tokenConsumedAt: at,
        updatedAt: at,
      };
      tx.set(intentRef, intentToDoc(intent));
      return { ok: true as const, intent };
    });
  }
}

// ---------------------------------------------------------------------------- conversations

const proposalToDoc = (p: PendingProposal | null) =>
  p
    ? {
        store_id: p.storeId,
        variant_id: p.variantId,
        quantity: p.quantity,
        proposed_at: p.proposedAt,
        expires_at: p.expiresAt,
        offered_stores: p.offeredStores,
      }
    : null;

const proposalFromDoc = (d: FirebaseFirestore.DocumentData | null | undefined): PendingProposal | null =>
  d
    ? {
        storeId: d.store_id,
        variantId: d.variant_id,
        quantity: d.quantity,
        proposedAt: d.proposed_at,
        expiresAt: d.expires_at,
        offeredStores: d.offered_stores ?? [],
      }
    : null;

const toConversation = (id: string, d: FirebaseFirestore.DocumentData): ConversationRecord => ({
  conversationId: id,
  brandId: d.brand_id,
  customerId: d.customer_id,
  channel: d.channel,
  status: 'OPEN',
  currentIntentId: d.current_intent_id ?? null,
  startedAt: d.started_at,
  updatedAt: d.updated_at,
  lastInboundAt: d.last_inbound_at ?? null,
  lastMessageAt: d.last_message_at ?? null,
  humanHandoff: d.human_handoff === true,
  pendingProposal: proposalFromDoc(d.pending_proposal),
  handoffAt: d.handoff_at ?? null,
  aiWindow: {
    windowStart: d.ai_window?.window_start ?? null,
    count: d.ai_window?.count ?? 0,
    noticeSent: d.ai_window?.notice_sent === true,
  },
});

const windowToDoc = (w: AiWindow) => ({ window_start: w.windowStart, count: w.count, notice_sent: w.noticeSent });

type OptionDoc = { option_id: string; label: string; description?: string; section?: string };
const optionToDoc = (o: OutboundOption): OptionDoc => ({
  option_id: o.optionId,
  label: o.label,
  ...(o.description ? { description: o.description } : {}),
  ...(o.section ? { section: o.section } : {}),
});
const optionFromDoc = (o: OptionDoc): OutboundOption => ({
  optionId: o.option_id,
  label: o.label,
  ...(o.description ? { description: o.description } : {}),
  ...(o.section ? { section: o.section } : {}),
});
/** Message parts (Change 16) in snake_case; absent on messages written before UI-2. */
const partsToDoc = (p: MessageParts | null | undefined) =>
  p
    ? {
        header: p.header ?? null,
        footer: p.footer ?? null,
        location: p.location ?? null,
        cta_url: p.ctaUrl ?? null,
        list_button: p.listButton ?? null,
      }
    : null;
function partsFromDoc(d: FirebaseFirestore.DocumentData | null | undefined): MessageParts | null {
  if (!d) return null;
  const p: MessageParts = {};
  if (d.header) p.header = d.header;
  if (d.footer) p.footer = d.footer;
  if (d.location) p.location = d.location;
  if (d.cta_url) p.ctaUrl = d.cta_url;
  if (d.list_button) p.listButton = d.list_button;
  return Object.keys(p).length ? p : null;
}

const toMessage = (id: string, d: FirebaseFirestore.DocumentData): MessageRecord => ({
  messageId: id,
  brandId: d.brand_id,
  conversationId: d.conversation_id,
  direction: d.direction,
  messageType: d.message_type,
  text: d.text ?? null,
  options: d.options ? d.options.map(optionFromDoc) : null,
  location: d.location ?? null,
  parts: partsFromDoc(d.parts),
  origin: d.origin,
  messageKind: d.message_kind ?? null,
  templateName: d.template_name ?? null,
  externalMessageId: d.external_message_id ?? null,
  deliveryStatus: d.delivery_status,
  timestamp: d.timestamp,
});

export class FirestoreConversationRepository implements ConversationRepository {
  constructor(private readonly db: Firestore) {}

  private col(brandId: string) {
    return brandCol(this.db, brandId, 'conversations');
  }

  async get(brandId: string, conversationId: string) {
    const snap = await this.col(brandId).doc(conversationId).get();
    return snap.exists ? toConversation(snap.id, snap.data()!) : null;
  }

  async findForCustomer(brandId: string, customerId: string, channel: Channel) {
    const snap = await this.col(brandId)
      .where('customer_id', '==', customerId)
      .where('channel', '==', channel)
      .limit(1)
      .get();
    return snap.empty ? null : toConversation(snap.docs[0]!.id, snap.docs[0]!.data());
  }

  async create(c: ConversationRecord) {
    await this.col(c.brandId)
      .doc(c.conversationId)
      .create({
        conversation_id: c.conversationId,
        brand_id: c.brandId,
        customer_id: c.customerId,
        channel: c.channel,
        status: c.status,
        current_intent_id: c.currentIntentId,
        started_at: c.startedAt,
        updated_at: c.updatedAt,
        last_inbound_at: c.lastInboundAt,
        last_message_at: c.lastMessageAt,
        human_handoff: c.humanHandoff,
        ai_window: windowToDoc(c.aiWindow),
        pending_proposal: proposalToDoc(c.pendingProposal),
        handoff_at: c.handoffAt,
      });
  }

  async update(brandId: string, conversationId: string, patch: Parameters<ConversationRepository['update']>[2]) {
    const doc: Record<string, unknown> = {};
    if (patch.currentIntentId !== undefined) doc.current_intent_id = patch.currentIntentId;
    if (patch.lastInboundAt !== undefined) doc.last_inbound_at = patch.lastInboundAt;
    if (patch.lastMessageAt !== undefined) doc.last_message_at = patch.lastMessageAt;
    if (patch.humanHandoff !== undefined) doc.human_handoff = patch.humanHandoff;
    if (patch.updatedAt !== undefined) doc.updated_at = patch.updatedAt;
    if (patch.pendingProposal !== undefined) doc.pending_proposal = proposalToDoc(patch.pendingProposal);
    if (patch.handoffAt !== undefined) doc.handoff_at = patch.handoffAt;
    await this.col(brandId).doc(conversationId).update(doc);
  }

  async list(brandId: string, limit: number) {
    const snap = await this.col(brandId).orderBy('updated_at', 'desc').limit(limit).get();
    return snap.docs.map((d) => toConversation(d.id, d.data()));
  }

  async consumeAiWindow(
    brandId: string,
    conversationId: string,
    next: (window: AiWindow) => { allowed: boolean; sendWaitNotice: boolean; next: AiWindow },
  ) {
    const ref = this.col(brandId).doc(conversationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const decision = next(toConversation(snap.id, snap.data()!).aiWindow);
      tx.update(ref, { ai_window: windowToDoc(decision.next) });
      return { allowed: decision.allowed, sendWaitNotice: decision.sendWaitNotice };
    });
  }

  async addMessage(m: MessageRecord) {
    await this.col(m.brandId)
      .doc(m.conversationId)
      .collection('messages')
      .doc(m.messageId)
      .create({
        message_id: m.messageId,
        brand_id: m.brandId,
        conversation_id: m.conversationId,
        direction: m.direction,
        message_type: m.messageType,
        text: m.text,
        options: m.options?.map(optionToDoc) ?? null,
        location: m.location,
        parts: partsToDoc(m.parts),
        origin: m.origin,
        message_kind: m.messageKind,
        template_name: m.templateName,
        external_message_id: m.externalMessageId,
        delivery_status: m.deliveryStatus,
        timestamp: m.timestamp,
      });
  }

  async listMessages(brandId: string, conversationId: string, afterMessageId?: string) {
    let q: FirebaseFirestore.Query = this.col(brandId).doc(conversationId).collection('messages').orderBy('message_id');
    if (afterMessageId) q = q.where('message_id', '>', afterMessageId);
    const snap = await q.get();
    return snap.docs.map((d) => toMessage(d.id, d.data()));
  }
}

// ---------------------------------------------------------------------------- recommendations

export class FirestoreRecommendationRepository implements RecommendationRepository {
  constructor(private readonly db: Firestore) {}

  async create(r: RecommendationRecord) {
    await brandCol(this.db, r.brandId, 'aiRecommendations')
      .doc(r.recommendationId)
      .create({
        recommendation_id: r.recommendationId,
        brand_id: r.brandId,
        customer_id: r.customerId,
        conversation_id: r.conversationId,
        intent_id: r.intentId,
        action: r.action,
        target_store_id: r.targetStoreId,
        target_variant_id: r.targetVariantId,
        confidence: r.confidence,
        rationale_summary: r.rationaleSummary,
        evidence_references: r.evidenceReferences,
        runtime: r.runtime,
        decision_source: r.decisionSource,
        guardrail_status: r.guardrailStatus,
        guardrail_reason: r.guardrailReason,
        proposed_at: r.proposedAt,
        // JSON round-trip: the trace is plain data and never contains undefined
        trace: r.trace ? JSON.parse(JSON.stringify(r.trace)) : null,
      });
  }

  private col(brandId: string) {
    return brandCol(this.db, brandId, 'aiRecommendations');
  }

  private async query(brandId: string, q: FirebaseFirestore.Query) {
    const snap = await q.get();
    return snap.docs
      .map((doc) => toRecommendation(brandId, doc.id, doc.data()))
      .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.recommendationId.localeCompare(b.recommendationId));
  }

  async get(brandId: string, recommendationId: string) {
    const snap = await this.col(brandId).doc(recommendationId).get();
    return snap.exists ? toRecommendation(brandId, snap.id, snap.data()!) : null;
  }

  listByConversation(brandId: string, conversationId: string) {
    return this.query(brandId, this.col(brandId).where('conversation_id', '==', conversationId));
  }

  listByIntent(brandId: string, intentId: string) {
    return this.query(brandId, this.col(brandId).where('intent_id', '==', intentId));
  }

  listProposedBetween(brandId: string, fromIso: string, toIso: string) {
    return this.query(brandId, this.col(brandId).where('proposed_at', '>=', fromIso).where('proposed_at', '<', toIso));
  }
}

const toRecommendation = (brandId: string, id: string, d: FirebaseFirestore.DocumentData): RecommendationRecord => ({
  recommendationId: id,
  brandId,
  customerId: d.customer_id,
  conversationId: d.conversation_id,
  intentId: d.intent_id ?? null,
  action: d.action,
  targetStoreId: d.target_store_id ?? null,
  targetVariantId: d.target_variant_id ?? null,
  confidence: d.confidence,
  rationaleSummary: d.rationale_summary,
  evidenceReferences: d.evidence_references ?? [],
  runtime: d.runtime,
  decisionSource: d.decision_source,
  guardrailStatus: d.guardrail_status,
  guardrailReason: d.guardrail_reason ?? null,
  proposedAt: d.proposed_at,
  trace: d.trace ?? null,
});

// ---------------------------------------------------------------------------- commerce events

export class FirestoreCommerceEventRepository implements CommerceEventRepository {
  constructor(private readonly db: Firestore) {}

  async record(e: CommerceEventRecord) {
    try {
      await brandCol(this.db, e.brandId, 'commerceEvents')
        .doc(e.eventId)
        .create({
          event_id: e.eventId,
          brand_id: e.brandId,
          customer_id: e.customerId,
          web_session_id: e.webSessionId,
          event_type: e.eventType,
          source: e.source,
          entity_reference: e.entityReference,
          event_payload_reference: null,
          payload: JSON.parse(JSON.stringify(e.payload)),
          timestamp: e.timestamp,
          idempotency_key: e.idempotencyKey,
        });
      return true;
    } catch (err) {
      if ((err as { code?: unknown }).code === 6) return false; // ALREADY_EXISTS: a replay
      throw err;
    }
  }

  async listByWebSession(brandId: string, webSessionId: string) {
    const snap = await brandCol(this.db, brandId, 'commerceEvents').where('web_session_id', '==', webSessionId).get();
    return snap.docs.map((doc): CommerceEventRecord => {
      const d = doc.data();
      return {
        eventId: doc.id,
        brandId,
        customerId: d.customer_id ?? null,
        webSessionId: d.web_session_id ?? null,
        eventType: d.event_type,
        source: d.source,
        entityReference: d.entity_reference ?? null,
        payload: d.payload ?? {},
        timestamp: d.timestamp,
        idempotencyKey: d.idempotency_key,
      };
    });
  }
}

// ---------------------------------------------------------------------------- webhook receipts

const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class FirestoreWebhookReceiptRepository implements WebhookReceiptRepository {
  constructor(private readonly db: Firestore) {}

  private ref(key: string) {
    return this.db.collection('webhookReceipts').doc(key.replace(/\//g, '_'));
  }

  async begin(key: string, meta: ReceiptMeta, now: Date) {
    const ref = this.ref(key);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.get('status') !== 'FAILED') {
        return {
          state: 'DUPLICATE' as const,
          status: snap.get('status') as 'PROCESSING' | 'PROCESSED',
          result: snap.get('result') ?? null,
        };
      }
      tx.set(ref, {
        receipt_id: key,
        brand_id: meta.brandId,
        provider: meta.provider,
        event_type: meta.eventType,
        external_event_id: meta.externalEventId,
        status: 'PROCESSING',
        result: null,
        received_at: now.toISOString(),
        expires_at: new Date(now.getTime() + RECEIPT_RETENTION_MS).toISOString(),
      });
      return { state: 'NEW' as const };
    });
  }

  async complete(key: string, result: unknown) {
    await this.ref(key).update({ status: 'PROCESSED', result: JSON.parse(JSON.stringify(result)) });
  }

  async peek(key: string) {
    const snap = await this.ref(key).get();
    return snap.exists ? { status: snap.get('status'), result: snap.get('result') ?? null } : null;
  }

  async fail(key: string) {
    const ref = this.ref(key);
    const snap = await ref.get();
    if (snap.exists) await ref.update({ status: 'FAILED' });
  }
}
