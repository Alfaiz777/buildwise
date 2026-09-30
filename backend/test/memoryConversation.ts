/** In-memory implementations of the M4 ports (same contracts as the Firestore adapters). */
import { newId } from '../src/lib/ids.js';
import type { TokenRejection } from '../src/domain/intentToken.js';
import type { AiWindow } from '../src/domain/conversationPolicy.js';
import type { Channel } from '../src/domain/channels.js';
import type {
  ChannelIdentity,
  CommerceEventRecord,
  CommerceEventRepository,
  ConsentState,
  ConversationRecord,
  ConversationRepository,
  CustomerRecord,
  CustomerRepository,
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
} from '../src/ports/conversationRepositories.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryCustomers implements CustomerRepository {
  readonly customers: CustomerRecord[] = [];
  async get(brandId: string, customerId: string) {
    const c = this.customers.find((x) => x.brandId === brandId && x.customerId === customerId);
    return c ? clone(c) : null;
  }
  async findByIdentity(brandId: string, identity: ChannelIdentity) {
    const c = this.customers.find(
      (x) =>
        x.brandId === brandId &&
        x.channelIdentities.some((i) => i.channel === identity.channel && i.externalRef === identity.externalRef),
    );
    return c ? clone(c) : null;
  }
  async findOrCreateByIdentity(
    brandId: string,
    identity: ChannelIdentity,
    create: { consentState: ConsentState; shopifyCustomerId: string | null; displayRef: string },
    now: string,
  ) {
    const existing = await this.findByIdentity(brandId, identity);
    if (existing) return { customer: existing, created: false };
    const customer: CustomerRecord = {
      customerId: newId('cus'),
      brandId,
      shopifyCustomerId: create.shopifyCustomerId,
      channelIdentities: [identity],
      consentState: create.consentState,
      optedOutAt: null,
      displayRef: create.displayRef,
      lastProactiveAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.customers.push(customer);
    return { customer: clone(customer), created: true };
  }
  async update(
    brandId: string,
    customerId: string,
    patch: Partial<Pick<CustomerRecord, 'consentState' | 'optedOutAt' | 'lastProactiveAt'>>,
  ) {
    const c = this.customers.find((x) => x.brandId === brandId && x.customerId === customerId);
    if (c) Object.assign(c, patch);
  }
}

export class MemoryVisitors implements VisitorLinkRepository {
  readonly links = new Map<string, VisitorLink>();
  async get(brandId: string, visitorHash: string) {
    return this.links.get(`${brandId}:${visitorHash}`) ?? null;
  }
  async link(brandId: string, visitorHash: string, link: VisitorLink) {
    this.links.set(`${brandId}:${visitorHash}`, { ...link });
  }
}

export class MemoryIntents implements IntentRepository {
  readonly intents: IntentRecord[] = [];
  private find(brandId: string, intentId: string) {
    return this.intents.findIndex((x) => x.brandId === brandId && x.intentId === intentId);
  }
  async get(brandId: string, intentId: string) {
    const i = this.find(brandId, intentId);
    return i >= 0 ? clone(this.intents[i]!) : null;
  }
  async update(brandId: string, intentId: string, fn: (current: IntentRecord | null) => IntentRecord | null) {
    const i = this.find(brandId, intentId);
    const next = fn(i >= 0 ? clone(this.intents[i]!) : null);
    if (next) {
      if (i >= 0) this.intents[i] = clone(next);
      else this.intents.push(clone(next));
    }
    return next ? clone(next) : null;
  }
  async list(brandId: string, limit: number) {
    return clone(
      this.intents
        .filter((x) => x.brandId === brandId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit),
    );
  }
  async listByCustomer(brandId: string, customerId: string) {
    return clone(this.intents.filter((x) => x.brandId === brandId && x.customerId === customerId));
  }
  async listByWebSessions(brandId: string, ids: string[]) {
    return clone(this.intents.filter((x) => x.brandId === brandId && ids.includes(x.webSessionId)));
  }
  async listIdleActive(brandId: string, beforeIso: string) {
    return clone(
      this.intents.filter((x) => x.brandId === brandId && x.status === 'ACTIVE' && x.lastEventAt <= beforeIso),
    );
  }
  async listDueFollowUps(brandId: string, nowIso: string) {
    return clone(
      this.intents.filter(
        (x) => x.brandId === brandId && x.followUp?.status === 'SCHEDULED' && (x.followUp.dueAt ?? '') <= nowIso,
      ),
    );
  }
}

export class MemoryTokens implements IntentTokenRepository {
  readonly tokens: IntentTokenRecord[] = [];
  constructor(private readonly intents: MemoryIntents) {}
  async create(t: IntentTokenRecord) {
    this.tokens.push({ ...t });
  }
  async countIssuedSince(brandId: string, webSessionId: string, sinceIso: string) {
    return this.tokens.filter((t) => t.brandId === brandId && t.webSessionId === webSessionId && t.issuedAt >= sinceIso)
      .length;
  }
  async consumeAndBind(
    tokenHash: string,
    brandId: string,
    customerId: string,
    now: Date,
    check: (token: IntentTokenRecord | null) => TokenRejection | null,
  ): Promise<{ ok: true; intent: IntentRecord | null } | { ok: false; reason: TokenRejection }> {
    const token = this.tokens.find((t) => t.tokenHash === tokenHash) ?? null;
    const reason = check(token ? { ...token } : null);
    if (reason) return { ok: false, reason };
    const at = now.toISOString();
    token!.consumedAt = at;
    token!.consumedByCustomerId = customerId;
    const intent = await this.intents.update(brandId, token!.intentId, (current) =>
      current ? { ...current, customerId, tokenConsumedAt: at, updatedAt: at } : null,
    );
    return { ok: true, intent };
  }
}

export class MemoryConversations implements ConversationRepository {
  readonly conversations: ConversationRecord[] = [];
  readonly messages: MessageRecord[] = [];
  private find(brandId: string, id: string) {
    return this.conversations.find((c) => c.brandId === brandId && c.conversationId === id);
  }
  async get(brandId: string, id: string) {
    const c = this.find(brandId, id);
    return c ? clone(c) : null;
  }
  async findForCustomer(brandId: string, customerId: string, channel: Channel) {
    const c = this.conversations.find(
      (x) => x.brandId === brandId && x.customerId === customerId && x.channel === channel,
    );
    return c ? clone(c) : null;
  }
  async create(c: ConversationRecord) {
    this.conversations.push(clone(c));
  }
  async update(brandId: string, id: string, patch: Partial<ConversationRecord>) {
    const c = this.find(brandId, id);
    if (c) Object.assign(c, patch);
  }
  async list(brandId: string, limit: number) {
    return clone(
      this.conversations
        .filter((c) => c.brandId === brandId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit),
    );
  }
  async consumeAiWindow(
    brandId: string,
    id: string,
    next: (w: AiWindow) => { allowed: boolean; sendWaitNotice: boolean; next: AiWindow },
  ) {
    const c = this.find(brandId, id)!;
    const d = next({ ...c.aiWindow });
    c.aiWindow = d.next;
    return { allowed: d.allowed, sendWaitNotice: d.sendWaitNotice };
  }
  async addMessage(m: MessageRecord) {
    this.messages.push(clone(m));
  }
  async listMessages(brandId: string, conversationId: string, after?: string) {
    return clone(
      this.messages
        .filter((m) => m.brandId === brandId && m.conversationId === conversationId && (!after || m.messageId > after))
        .sort((a, b) => a.messageId.localeCompare(b.messageId)),
    );
  }
}

export class MemoryRecommendations implements RecommendationRepository {
  readonly recommendations: RecommendationRecord[] = [];
  async create(r: RecommendationRecord) {
    this.recommendations.push(clone(r));
  }
  async listByConversation(brandId: string, conversationId: string) {
    return clone(this.recommendations.filter((r) => r.brandId === brandId && r.conversationId === conversationId));
  }
}

export class MemoryEvents implements CommerceEventRepository {
  readonly events: CommerceEventRecord[] = [];
  async record(e: CommerceEventRecord) {
    if (this.events.some((x) => x.brandId === e.brandId && x.eventId === e.eventId)) return false;
    this.events.push(clone(e));
    return true;
  }
  async listByWebSession(brandId: string, webSessionId: string) {
    return clone(this.events.filter((e) => e.brandId === brandId && e.webSessionId === webSessionId));
  }
}

export class MemoryReceipts implements WebhookReceiptRepository {
  readonly receipts = new Map<
    string,
    { status: 'PROCESSING' | 'PROCESSED' | 'FAILED'; result: unknown; meta: ReceiptMeta }
  >();
  async begin(key: string, meta: ReceiptMeta) {
    const r = this.receipts.get(key);
    if (r && r.status !== 'FAILED') return { state: 'DUPLICATE' as const, status: r.status, result: clone(r.result) };
    this.receipts.set(key, { status: 'PROCESSING', result: null, meta });
    return { state: 'NEW' as const };
  }
  async complete(key: string, result: unknown) {
    const r = this.receipts.get(key);
    if (r) Object.assign(r, { status: 'PROCESSED', result: clone(result) });
  }
  async fail(key: string) {
    const r = this.receipts.get(key);
    if (r) r.status = 'FAILED';
  }
}
