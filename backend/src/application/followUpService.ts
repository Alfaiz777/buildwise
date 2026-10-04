import { resolveMessagingSettings } from '../domain/brandSettings.js';
import type { Channel } from '../domain/channels.js';
import { messageKindFor } from '../domain/conversationPolicy.js';
import { toOutboundOptions } from '../domain/agentReplies.js';
import { composeFollowUp } from '../domain/followUpMessages.js';
import {
  evaluateFollowUp,
  FOLLOW_UP_TYPES,
  isInactive,
  resolveFollowUpSettings,
  type FollowUpDecision,
  type FollowUpType,
} from '../domain/followUpPolicy.js';
import { newId } from '../lib/ids.js';
import type {
  ConversationRecord,
  ConversationRepository,
  CustomerRecord,
  CustomerRepository,
  FollowUpState,
  IntentRecord,
  IntentRepository,
} from '../ports/conversationRepositories.js';
import type { BrandRecord, BrandRepository, ProductRepository } from '../ports/repositories.js';
import { sendAndPersist, type OutboundDeps } from './conversation/outbound.js';
import type { PipelineContext } from './conversation/pipeline.js';

export interface FollowUpDeps extends OutboundDeps {
  brands: BrandRepository;
  products: ProductRepository;
  customers: CustomerRepository;
  intents: IntentRepository;
  /** M5: expires overdue reservation holds as part of the due-work run. */
  expireReservations?: (brandId: string) => Promise<number>;
  /** M6: closes engaged journeys whose attribution window passed with no purchase (NONE outcomes). */
  closeJourneys?: (brandId: string) => Promise<number>;
}

export interface ProcessDueResult {
  abandoned: number;
  sent: number;
  suppressed: number;
  /** M5: overdue reservation holds expired (and released) in this run. */
  reservationsExpired: number;
  /** M6: NONE outcomes recorded in this run. */
  outcomesClosed: number;
  results: { intentId: string; outcome: 'SENT' | 'SUPPRESSED'; reason: string | null }[];
}

/** Statuses after which the engine never touches the follow-up again. */
const FINAL = new Set(['SENT', 'REPLIED', 'CONVERTED', 'HANDOFF', 'OPTED_OUT', 'SUPPRESSED']);
const isFollowUpType = (t: string): t is FollowUpType => (FOLLOW_UP_TYPES as readonly string[]).includes(t);

/**
 * Proactive follow-up engine (docs/00 §11.8 Change 11, D1/D5/D6; docs/04 §11.3).
 * - evaluate(): after every intent update, schedule (with due_at) or record why not.
 * - processDue(): mark idle intents ABANDONED; for each due follow-up re-check the policy
 *   AT SEND TIME, then send through the shared outbound path, or SUPPRESS with the reason.
 * There is no external scheduler in M4: a Brand Admin action (or a local auto-poll) calls
 * processDue; in gcp Cloud Scheduler calls the same endpoint (L-phase).
 */
export class FollowUpService {
  constructor(private readonly deps: FollowUpDeps) {}

  private enabledChannels(): Channel[] {
    return [...this.deps.messaging.keys()];
  }

  private async context(brandId: string, intent: IntentRecord) {
    const customer = intent.customerId ? await this.deps.customers.get(brandId, intent.customerId) : null;
    const channel = customer ? pickChannel(customer, this.enabledChannels()) : null;
    const conversation =
      customer && channel ? await this.deps.conversations.findForCustomer(brandId, customer.customerId, channel) : null;
    return { customer, channel, conversation };
  }

  private decide(
    brand: BrandRecord,
    intent: IntentRecord,
    ctx: Awaited<ReturnType<FollowUpService['context']>>,
  ): FollowUpDecision {
    return evaluateFollowUp({
      intent: {
        type: intent.type,
        strength: intent.strength,
        status: intent.status,
        matchedCategory: intent.matchedCategory,
        detectedAt: intent.detectedAt,
        lastEventAt: intent.lastEventAt,
        tokenConsumedAt: intent.tokenConsumedAt,
        followUpStatus: intent.followUp?.status ?? null,
      },
      customer: ctx.customer
        ? {
            channel: ctx.channel,
            consentState: ctx.customer.consentState,
            lastProactiveAt: ctx.customer.lastProactiveAt,
          }
        : null,
      conversation: ctx.conversation
        ? { humanHandoff: ctx.conversation.humanHandoff, lastInboundAt: ctx.conversation.lastInboundAt }
        : null,
      enabledChannels: this.enabledChannels(),
      settings: resolveFollowUpSettings(brand.settings.follow_up_policy),
      now: this.deps.now(),
    });
  }

  /** Scheduling-time evaluation; never overrides a final follow-up state. */
  async evaluate(brandId: string, intentId: string): Promise<IntentRecord | null> {
    const brand = await this.deps.brands.getById(brandId);
    const intent = await this.deps.intents.get(brandId, intentId);
    if (!brand || !intent || (intent.followUp && FINAL.has(intent.followUp.status))) return intent;
    const decision = this.decide(brand, intent, await this.context(brandId, intent));
    const at = this.deps.now().toISOString();

    let scheduledNow = false;
    const updated = await this.deps.intents.update(brandId, intentId, (current) => {
      if (!current || (current.followUp && FINAL.has(current.followUp.status))) return null;
      const next: FollowUpState =
        decision.decision === 'FOLLOW_UP_ELIGIBLE'
          ? {
              ...emptyFollowUp(at),
              decision: decision.decision,
              reason: decision.reason,
              dueAt: decision.dueAt,
              priority: decision.priority,
              status: 'SCHEDULED',
            }
          : { ...emptyFollowUp(at), decision: decision.decision, reason: decision.reason, status: 'NOT_ELIGIBLE' };
      scheduledNow = next.status === 'SCHEDULED' && current.followUp?.status !== 'SCHEDULED';
      return { ...current, followUp: next };
    });
    if (updated && scheduledNow) {
      await this.deps.events.record({
        brandId,
        eventType: 'FOLLOW_UP_SCHEDULED',
        source: 'QWIKSPOT',
        customerId: updated.customerId,
        webSessionId: updated.webSessionId,
        entityReference: intentId,
        payload: { intent_type: updated.type, due_at: updated.followUp!.dueAt, priority: updated.followUp!.priority },
        idempotencyKey: `FOLLOW_UP_SCHEDULED:${intentId}:${updated.followUp!.evaluatedAt}`,
        at,
      });
    }
    return updated ?? intent;
  }

  /** Re-evaluates the open intents of a customer (e.g. after a sign-in linked them). */
  async evaluateForCustomer(brandId: string, customerId: string): Promise<void> {
    for (const intent of await this.deps.intents.listByCustomer(brandId, customerId)) {
      if (intent.status !== 'CONVERTED') await this.evaluate(brandId, intent.intentId);
    }
  }

  async processDue(
    brandId: string,
    actor: { type: 'USER' | 'SYSTEM'; id: string } = { type: 'SYSTEM', id: 'scheduler' },
  ): Promise<ProcessDueResult> {
    const brand = await this.deps.brands.getById(brandId);
    const result: ProcessDueResult = {
      abandoned: 0,
      sent: 0,
      suppressed: 0,
      reservationsExpired: 0,
      outcomesClosed: 0,
      results: [],
    };
    if (!brand) return result;
    // M5: the same due-work run expires overdue reservation holds (docs/03 §15).
    if (this.deps.expireReservations) result.reservationsExpired = await this.deps.expireReservations(brandId);
    const settings = resolveFollowUpSettings(brand.settings.follow_up_policy);
    const now = this.deps.now();

    // 1. Inactivity → ABANDONED ("abandonment" is a conclusion, never a live state).
    const idleBefore = new Date(now.getTime() - settings.inactivityMinutes * 60_000).toISOString();
    for (const intent of await this.deps.intents.listIdleActive(brandId, idleBefore)) {
      const updated = await this.deps.intents.update(brandId, intent.intentId, (current) =>
        current && current.status === 'ACTIVE' && isInactive(current.lastEventAt, settings, now)
          ? { ...current, status: 'ABANDONED', updatedAt: now.toISOString() }
          : null,
      );
      if (updated) result.abandoned += 1;
    }

    // 2. Due follow-ups: claim atomically, re-check the policy, then send or suppress.
    for (const due of await this.deps.intents.listDueFollowUps(brandId, now.toISOString())) {
      const claimedAt = now.toISOString();
      const claimed = await this.deps.intents.update(brandId, due.intentId, (current) =>
        current?.followUp?.status === 'SCHEDULED' &&
        !current.followUp.claimedAt &&
        (current.followUp.dueAt ?? '') <= claimedAt
          ? { ...current, followUp: { ...current.followUp, claimedAt } }
          : null,
      );
      if (!claimed) continue; // another run got it: never send twice
      const outcome = await this.sendOrSuppress(brand, claimed);
      result.results.push(outcome);
      if (outcome.outcome === 'SENT') result.sent += 1;
      else result.suppressed += 1;
    }
    // M6: NONE only after the attribution window, and only from this sweep (Change 13, F5).
    if (this.deps.closeJourneys) result.outcomesClosed = await this.deps.closeJourneys(brandId);
    await this.deps.events.audit(brandId, {
      action: 'DUE_WORK_PROCESSED',
      targetType: 'BRAND',
      targetId: brandId,
      reasonCode: `sent=${result.sent},suppressed=${result.suppressed},abandoned=${result.abandoned},expired=${result.reservationsExpired},closed=${result.outcomesClosed}`,
      actor,
    });
    return result;
  }

  private async sendOrSuppress(brand: BrandRecord, intent: IntentRecord) {
    const brandId = brand.brandId;
    const ctx = await this.context(brandId, intent);
    // The same policy, re-checked at send time (the claim itself is not a follow-up status).
    const decision = this.decide(
      brand,
      { ...intent, followUp: intent.followUp && { ...intent.followUp, status: 'SCHEDULED' } },
      ctx,
    );
    const at = this.deps.now().toISOString();

    if (
      decision.decision === 'FOLLOW_UP_NOT_ELIGIBLE' ||
      !ctx.customer ||
      !ctx.channel ||
      !isFollowUpType(intent.type)
    ) {
      const reason = decision.decision === 'FOLLOW_UP_NOT_ELIGIBLE' ? decision.reason : 'CUSTOMER_NOT_REACHABLE';
      await this.deps.intents.update(brandId, intent.intentId, (current) =>
        current?.followUp
          ? { ...current, followUp: { ...current.followUp, status: 'SUPPRESSED', reason, evaluatedAt: at } }
          : null,
      );
      await this.deps.events.record({
        brandId,
        eventType: 'FOLLOW_UP_SUPPRESSED',
        source: 'QWIKSPOT',
        customerId: intent.customerId,
        webSessionId: intent.webSessionId,
        entityReference: intent.intentId,
        payload: { reason },
        idempotencyKey: `FOLLOW_UP_SUPPRESSED:${intent.intentId}`,
        at,
      });
      await this.deps.events.audit(brandId, {
        action: 'FOLLOW_UP_SUPPRESSED',
        targetType: 'INTENT',
        targetId: intent.intentId,
        reasonCode: reason,
      });
      return { intentId: intent.intentId, outcome: 'SUPPRESSED' as const, reason };
    }

    const customer = ctx.customer;
    const conversation =
      ctx.conversation ?? (await this.openConversation(brandId, customer, ctx.channel, intent.intentId, at));
    if (conversation.currentIntentId !== intent.intentId) {
      await this.deps.conversations.update(brandId, conversation.conversationId, {
        currentIntentId: intent.intentId,
        updatedAt: at,
      });
    }
    const kind = messageKindFor(conversation.lastInboundAt, this.deps.now());
    const titles = await this.titles(brandId, intent);
    const message = composeFollowUp({
      type: intent.type,
      kind,
      brandName: resolveMessagingSettings(brand.settings, brand.name).displayName,
      productTitle: titles.product,
      variantTitle: titles.variant,
      category: intent.matchedCategory,
      variantId: titles.variant ? intent.variantId : null,
      imageUrl: titles.imageUrl,
    });
    const { message: sent } = await sendAndPersist(
      this.deps,
      { ...conversation, currentIntentId: intent.intentId },
      customer,
      {
        text: message.text,
        messageType: kind === 'TEMPLATE' ? 'TEMPLATE' : 'INTERACTIVE',
        options: toOutboundOptions(message.options),
        parts: message.parts,
        origin: 'PROACTIVE_FOLLOW_UP',
        messageKind: kind,
        templateName: message.templateName,
        actionReference: intent.intentId,
      },
    );
    await this.deps.customers.update(brandId, customer.customerId, { lastProactiveAt: at });
    await this.deps.intents.update(brandId, intent.intentId, (current) =>
      current?.followUp
        ? {
            ...current,
            followUp: {
              ...current.followUp,
              status: 'SENT',
              messageKind: kind,
              templateName: message.templateName,
              sentMessageId: sent.messageId,
              conversationId: conversation.conversationId,
              sentAt: at,
            },
          }
        : null,
    );
    await this.deps.events.record({
      brandId,
      eventType: 'FOLLOW_UP_SENT',
      source: 'QWIKSPOT',
      customerId: customer.customerId,
      webSessionId: intent.webSessionId,
      entityReference: intent.intentId,
      payload: { message_kind: kind, template_name: message.templateName, intent_type: intent.type },
      idempotencyKey: `FOLLOW_UP_SENT:${intent.intentId}`,
      at,
    });
    await this.deps.events.audit(brandId, {
      action: 'FOLLOW_UP_SENT',
      targetType: 'INTENT',
      targetId: intent.intentId,
    });
    return { intentId: intent.intentId, outcome: 'SENT' as const, reason: null };
  }

  private async openConversation(
    brandId: string,
    customer: CustomerRecord,
    channel: Channel,
    intentId: string,
    at: string,
  ): Promise<ConversationRecord> {
    const conversation: ConversationRecord = {
      conversationId: newId('conv'),
      brandId,
      customerId: customer.customerId,
      channel,
      status: 'OPEN',
      currentIntentId: intentId,
      startedAt: at,
      updatedAt: at,
      lastInboundAt: null,
      lastMessageAt: null,
      humanHandoff: false,
      aiWindow: { windowStart: null, count: 0, noticeSent: false },
      pendingProposal: null,
      handoffAt: null,
    };
    await this.deps.conversations.create(conversation);
    return conversation;
  }

  private async titles(brandId: string, intent: IntentRecord) {
    if (!intent.productId) return { product: null, variant: null, imageUrl: null };
    const [products, variants] = await Promise.all([
      this.deps.products.listProducts(brandId),
      this.deps.products.listVariants(brandId),
    ]);
    const product = products.find((p) => p.productId === intent.productId);
    return {
      product: product?.title ?? null,
      variant: variants.find((v) => v.variantId === intent.variantId)?.title ?? null,
      imageUrl: product?.imageUrl ?? null,
    };
  }

  /**
   * Pipeline OUTCOME hook: after a customer message, the current intent's follow-up
   * becomes OPTED_OUT (STOP), HANDOFF (asked for a person) or REPLIED. Automation stops
   * for the first two.
   */
  async onReply(context: PipelineContext): Promise<void> {
    const brandId = context.inbound.brandId;
    const intent = context.data.intent;
    if (!intent) return;
    const optedOut = context.data.policy?.reply === 'NONE' && context.data.policy.reason === 'OPT_OUT_REQUEST';
    const handoff = context.data.handoffStarted === true;
    const at = this.deps.now().toISOString();
    await this.deps.intents.update(brandId, intent.intentId, (current) => {
      if (!current) return null;
      const status = current.followUp?.status;
      if (optedOut && status !== 'OPTED_OUT') {
        return {
          ...current,
          followUp: { ...(current.followUp ?? emptyFollowUp(at)), status: 'OPTED_OUT', reason: 'OPTED_OUT' },
        };
      }
      if (handoff && status !== 'HANDOFF') {
        return {
          ...current,
          followUp: { ...(current.followUp ?? emptyFollowUp(at)), status: 'HANDOFF', reason: 'HUMAN_HANDOFF' },
        };
      }
      if (status === 'SENT') return { ...current, followUp: { ...current.followUp!, status: 'REPLIED' } };
      // The customer is already talking to us: a pending follow-up is no longer needed.
      if (status === 'SCHEDULED') {
        return {
          ...current,
          followUp: {
            ...current.followUp!,
            status: 'NOT_ELIGIBLE',
            decision: 'FOLLOW_UP_NOT_ELIGIBLE',
            reason: 'CUSTOMER_ALREADY_IN_CONVERSATION',
            evaluatedAt: at,
          },
        };
      }
      return null;
    });
  }

  /**
   * Order path (ORDER_CREATED): the session's intent becomes CONVERTED. A follow-up that
   * was still pending is SUPPRESSED (ALREADY_CONVERTED); one already sent becomes CONVERTED.
   */
  async markConverted(brandId: string, intentId: string): Promise<IntentRecord | null> {
    const at = this.deps.now().toISOString();
    let suppressed = false;
    const updated = await this.deps.intents.update(brandId, intentId, (current) => {
      if (!current || current.status === 'CONVERTED') return null;
      const f = current.followUp;
      suppressed = f?.status === 'SCHEDULED';
      const followUp = !f
        ? f
        : f.status === 'SCHEDULED'
          ? { ...f, status: 'SUPPRESSED' as const, reason: 'ALREADY_CONVERTED', evaluatedAt: at }
          : f.status === 'SENT' || f.status === 'REPLIED'
            ? { ...f, status: 'CONVERTED' as const }
            : f;
      return { ...current, status: 'CONVERTED', updatedAt: at, followUp };
    });
    if (updated && suppressed) {
      await this.deps.events.record({
        brandId,
        eventType: 'FOLLOW_UP_SUPPRESSED',
        source: 'QWIKSPOT',
        customerId: updated.customerId,
        webSessionId: updated.webSessionId,
        entityReference: intentId,
        payload: { reason: 'ALREADY_CONVERTED' },
        idempotencyKey: `FOLLOW_UP_SUPPRESSED:${intentId}`,
        at,
      });
    }
    return updated;
  }
}

const emptyFollowUp = (at: string): FollowUpState => ({
  decision: 'FOLLOW_UP_NOT_ELIGIBLE',
  reason: 'WEAK_INTENT',
  evaluatedAt: at,
  dueAt: null,
  priority: null,
  status: 'NOT_ELIGIBLE',
  messageKind: null,
  templateName: null,
  sentMessageId: null,
  conversationId: null,
  claimedAt: null,
  sentAt: null,
});

/** The customer's channel for proactive contact: WhatsApp first, else the simulator. */
function pickChannel(customer: CustomerRecord, enabled: Channel[]): Channel | null {
  const channels = customer.channelIdentities.map((i) => i.channel);
  return (
    channels.find((c) => c === 'WHATSAPP' && enabled.includes(c)) ??
    channels.find((c) => enabled.includes(c)) ??
    channels[0] ??
    null
  );
}
