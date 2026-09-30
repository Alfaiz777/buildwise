/**
 * The M4 implementation of the ConversationPipeline stages (docs/03_TECH_ARCHITECTURE.md
 * §8.2). Stages 1–5 and 9–10 are real; 6 is the deterministic fallback (docs/03 §16.2);
 * 7–8 are pass-through so that M5 plugs the agent runtime, guardrail and tools in without
 * reordering. The fixed order is enforced by ConversationPipeline.
 */
import type { AgentRuntimeName } from '../../domain/ai.js';
import { resolveMessagingSettings } from '../../domain/brandSettings.js';
import {
  decideInboundPolicy,
  isHumanRequest,
  isOptOutRequest,
  nextAiWindow,
  truncateInbound,
} from '../../domain/conversationPolicy.js';
import { buildFallbackDecision } from '../../domain/fallbackDecision.js';
import { checkIntentToken, extractIntentToken, hashIntentToken } from '../../domain/intentToken.js';
import { newId, sortableId } from '../../lib/ids.js';
import { AgentDecisionSchema } from '../../ports/agent.js';
import type {
  ConversationRecord,
  ConversationRepository,
  CustomerRepository,
  IntentRecord,
  IntentRepository,
  IntentTokenRepository,
  RecommendationRepository,
  VisitorLinkRepository,
  WebhookReceiptRepository,
} from '../../ports/conversationRepositories.js';
import type { BrandRepository, ProductRepository } from '../../ports/repositories.js';
import type { EventRecorder } from '../eventRecorder.js';
import { sendAndPersist, type OutboundDeps } from './outbound.js';
import { CONTINUE, ConversationPipeline, type PipelineContext, type PipelineStage } from './pipeline.js';

export interface ConversationDeps extends OutboundDeps {
  brands: BrandRepository;
  products: ProductRepository;
  customers: CustomerRepository;
  visitors: VisitorLinkRepository;
  intents: IntentRepository;
  tokens: IntentTokenRepository;
  recommendations: RecommendationRepository;
  receipts: WebhookReceiptRepository;
  /** The configured AgentRuntime's name (recorded on every decision). */
  runtimeName: AgentRuntimeName;
  /** OUTCOME hook for the follow-up engine (M4 part 2). */
  onReply?: (context: PipelineContext) => Promise<void>;
}

export const WAIT_NOTICE = 'Thanks for your patience. We have received your messages and will get back to you shortly.';

/** docs/03 §16.3: SIMULATOR:{brand_id}:MESSAGE:{client_message_id}. */
export const receiptKeyFor = (context: PipelineContext) =>
  `${context.inbound.channel}:${context.inbound.brandId}:MESSAGE:${context.inbound.externalMessageId}`;

const need = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) throw new Error(`Pipeline invariant: ${what} is not set`);
  return value;
};

export function buildConversationPipeline(deps: ConversationDeps): ConversationPipeline {
  const now = () => deps.now();

  /** 1. IDEMPOTENCY — create-if-absent receipt; duplicates stop the run. */
  const idempotency: PipelineStage = {
    name: 'IDEMPOTENCY',
    async run(context) {
      const key = receiptKeyFor(context);
      context.data.receiptKey = key;
      const begin = await deps.receipts.begin(
        key,
        {
          brandId: context.inbound.brandId,
          provider: context.inbound.channel === 'WHATSAPP' ? 'WHATSAPP' : 'SIMULATOR',
          eventType: 'MESSAGE',
          externalEventId: context.inbound.externalMessageId,
        },
        now(),
      );
      if (begin.state === 'DUPLICATE') {
        context.data.duplicate = { status: begin.status, result: begin.result };
        return { stop: true, reason: 'DUPLICATE_DELIVERY' };
      }
      return CONTINUE;
    },
  };

  /** 2. IDENTITY — Customer by channel identity; created on the first message. */
  const identity: PipelineStage = {
    name: 'IDENTITY',
    async run(context) {
      const brand = need(await deps.brands.getById(context.inbound.brandId), 'brand');
      context.data.brand = brand;
      const { customer, created } = await deps.customers.findOrCreateByIdentity(
        brand.brandId,
        { channel: context.inbound.channel, externalRef: context.inbound.externalCustomerRef },
        { consentState: 'UNKNOWN', shopifyCustomerId: null, displayRef: context.inbound.externalCustomerRef },
        now().toISOString(),
      );
      context.customerId = customer.customerId;
      context.data.customer = customer;
      context.data.customerCreated = created;
      return CONTINUE;
    },
  };

  /** 3. HANDSHAKE — START_BUILDWISE_<token>: strip always; validate + consume + bind in one transaction. */
  const handshake: PipelineStage = {
    name: 'HANDSHAKE',
    async run(context) {
      const content = context.inbound.content;
      if (content.type !== 'TEXT') {
        context.data.text = null;
        return CONTINUE;
      }
      const { token, text } = extractIntentToken(content.text);
      context.data.text = truncateInbound(text);
      if (!token) return CONTINUE;

      const brandId = context.inbound.brandId;
      const customerId = need(context.customerId, 'customerId');
      const result = await deps.tokens.consumeAndBind(hashIntentToken(token), brandId, customerId, now(), (t) =>
        checkIntentToken(t, brandId, now()),
      );
      if (!result.ok) {
        // No oracle: the customer is never told; the attempt is audited.
        await deps.events.audit(brandId, {
          action: 'INTENT_TOKEN_REJECTED',
          targetType: 'CUSTOMER',
          targetId: customerId,
          result: 'DENIED',
          reasonCode: result.reason,
        });
        return CONTINUE;
      }
      if (result.intent) {
        context.intentId = result.intent.intentId;
        context.data.intent = result.intent;
        if (result.intent.visitorHash) {
          await deps.visitors.link(brandId, result.intent.visitorHash, {
            customerId,
            linkSource: 'HANDSHAKE',
            linkedAt: now().toISOString(),
          });
        }
        await deps.events.audit(brandId, {
          action: 'INTENT_TOKEN_BOUND',
          targetType: 'INTENT',
          targetId: result.intent.intentId,
        });
      }
      return CONTINUE;
    },
  };

  /** 4. CONVERSATION_STATE — create/update the Conversation, persist the inbound message. */
  const conversationState: PipelineStage = {
    name: 'CONVERSATION_STATE',
    async run(context) {
      const brandId = context.inbound.brandId;
      const customerId = need(context.customerId, 'customerId');
      const at = now().toISOString();
      let conversation = await deps.conversations.findForCustomer(brandId, customerId, context.inbound.channel);
      if (!conversation) {
        conversation = {
          conversationId: newId('conv'),
          brandId,
          customerId,
          channel: context.inbound.channel,
          status: 'OPEN',
          currentIntentId: context.intentId,
          startedAt: at,
          updatedAt: at,
          lastInboundAt: at,
          lastMessageAt: at,
          humanHandoff: false,
          aiWindow: { windowStart: null, count: 0, noticeSent: false },
        };
        await deps.conversations.create(conversation);
        context.data.conversationCreated = true;
      } else {
        const currentIntentId = context.intentId ?? conversation.currentIntentId;
        await deps.conversations.update(brandId, conversation.conversationId, {
          currentIntentId,
          lastInboundAt: at,
          lastMessageAt: at,
          updatedAt: at,
        });
        conversation = { ...conversation, currentIntentId, lastInboundAt: at, lastMessageAt: at, updatedAt: at };
      }
      context.conversationId = conversation.conversationId;
      context.data.conversation = conversation;
      if (!context.data.intent && conversation.currentIntentId) {
        context.data.intent = await deps.intents.get(brandId, conversation.currentIntentId);
        context.intentId = context.data.intent?.intentId ?? null;
      }

      const content = context.inbound.content;
      const inboundMessageId = sortableId('msg', now());
      await deps.conversations.addMessage({
        messageId: inboundMessageId,
        brandId,
        conversationId: conversation.conversationId,
        direction: 'INBOUND',
        messageType: content.type,
        text: content.type === 'TEXT' ? (context.data.text ?? '') : null,
        options: null,
        location: content.type === 'LOCATION' ? { latitude: content.latitude, longitude: content.longitude } : null,
        origin: 'CUSTOMER',
        messageKind: null,
        templateName: null,
        externalMessageId: context.inbound.externalMessageId,
        deliveryStatus: 'RECEIVED',
        timestamp: at,
      });
      context.data.inboundMessageId = inboundMessageId;
      return CONTINUE;
    },
  };

  /** 5. POLICY — opt-out, handoff, window, per-conversation AI limit. */
  const policy: PipelineStage = {
    name: 'POLICY',
    async run(context) {
      const brandId = context.inbound.brandId;
      const customer = need(context.data.customer, 'customer');
      const conversation = need(context.data.conversation, 'conversation');
      const text = context.data.text ?? '';

      if (isOptOutRequest(text)) {
        await deps.customers.update(brandId, customer.customerId, {
          consentState: 'OPTED_OUT',
          optedOutAt: now().toISOString(),
        });
        context.data.customer = { ...customer, consentState: 'OPTED_OUT', optedOutAt: now().toISOString() };
        await deps.events.audit(brandId, {
          action: 'CUSTOMER_OPTED_OUT',
          targetType: 'CUSTOMER',
          targetId: customer.customerId,
        });
        context.data.policy = { reply: 'NONE', reason: 'OPT_OUT_REQUEST' };
        return CONTINUE;
      }
      const automationAllowed = customer.consentState !== 'OPTED_OUT' && !conversation.humanHandoff;
      const aiWindow = automationAllowed
        ? await deps.conversations.consumeAiWindow(brandId, conversation.conversationId, (w) => nextAiWindow(w, now()))
        : { allowed: true, sendWaitNotice: false };
      context.data.policy = decideInboundPolicy({
        text,
        consentState: customer.consentState,
        humanHandoff: conversation.humanHandoff,
        aiWindow,
      });
      return CONTINUE;
    },
  };

  /** 6. AGENT — M4: the deterministic fallback decision (no agent runtime yet). */
  const agent: PipelineStage = {
    name: 'AGENT',
    async run(context) {
      if (context.data.policy?.reply !== 'AUTOMATED') return CONTINUE;
      const brand = need(context.data.brand, 'brand');
      const messaging = resolveMessagingSettings(brand.settings, brand.name);
      const intent = context.data.intent ?? null;
      const productTitle = intent?.productId ? await titleOf(deps.products, brand.brandId, intent) : null;
      context.decision = AgentDecisionSchema.parse(
        buildFallbackDecision({
          runtime: deps.runtimeName,
          wantsHuman: isHumanRequest(context.data.text ?? ''),
          handoffEnabled: messaging.handoffEnabled,
          brandName: messaging.displayName,
          intent: intent ? { type: intent.type, productTitle } : null,
        }),
      );
      context.decisionSource = 'DETERMINISTIC_FALLBACK';
      return CONTINUE;
    },
  };

  /** 7. GUARDRAIL — pass-through in M4: the fallback never proposes an executable action. */
  const guardrail: PipelineStage = {
    name: 'GUARDRAIL',
    async run(context) {
      if (context.decision) context.guardrailStatus = 'ALLOWED';
      return CONTINUE;
    },
  };

  /** 8. TOOLS — none in M4 (agent tools arrive in M5). */
  const tools: PipelineStage = { name: 'TOOLS', run: async () => CONTINUE };

  /** 9. PERSISTENCE — recommendation, handoff state, CommerceEvents, AuditEvents. */
  const persistence: PipelineStage = {
    name: 'PERSISTENCE',
    async run(context) {
      const brandId = context.inbound.brandId;
      const at = now().toISOString();
      const customerId = need(context.customerId, 'customerId');
      const conversation = need(context.data.conversation, 'conversation');
      const inboundId = need(context.data.inboundMessageId, 'inboundMessageId');
      const base = { brandId, customerId, entityReference: conversation.conversationId, at };

      if (context.data.conversationCreated) {
        await deps.events.record({
          ...base,
          eventType: 'CONVERSATION_STARTED',
          source: context.inbound.channel,
          payload: { conversation_id: conversation.conversationId, intent_id: context.intentId },
          idempotencyKey: `CONVERSATION_STARTED:${conversation.conversationId}`,
        });
      }
      await deps.events.record({
        ...base,
        eventType: 'MESSAGE_RECEIVED',
        source: context.inbound.channel,
        payload: { conversation_id: conversation.conversationId, message_type: context.inbound.content.type },
        idempotencyKey: `MESSAGE_RECEIVED:${inboundId}`,
      });

      const drafts = [];
      const decision = context.decision;
      if (decision) {
        const recommendationId = newId('rec');
        context.data.recommendationId = recommendationId;
        await deps.recommendations.create({
          recommendationId,
          brandId,
          customerId,
          conversationId: conversation.conversationId,
          intentId: context.intentId,
          action: decision.next_best_action.action,
          targetStoreId: null,
          targetVariantId: context.data.intent?.variantId ?? null,
          confidence: decision.intent.confidence,
          rationaleSummary: decision.next_best_action.reason,
          evidenceReferences: [],
          runtime: decision.runtime,
          decisionSource: context.decisionSource ?? 'DETERMINISTIC_FALLBACK',
          guardrailStatus: context.guardrailStatus ?? 'ALLOWED',
          proposedAt: at,
        });
        await deps.events.record({
          ...base,
          eventType: 'AI_DECISION',
          source: 'BUILDWISE',
          entityReference: recommendationId,
          payload: {
            action: decision.next_best_action.action,
            runtime: decision.runtime,
            decision_source: context.decisionSource,
          },
          idempotencyKey: `AI_DECISION:${recommendationId}`,
        });
        if (decision.next_best_action.action === 'HUMAN_HANDOFF') {
          await deps.conversations.update(brandId, conversation.conversationId, { humanHandoff: true, updatedAt: at });
          context.data.conversation = { ...conversation, humanHandoff: true };
          context.data.handoffStarted = true;
          await deps.events.record({
            ...base,
            eventType: 'HUMAN_HANDOFF',
            source: 'BUILDWISE',
            payload: { conversation_id: conversation.conversationId },
            idempotencyKey: `HUMAN_HANDOFF:${recommendationId}`,
          });
          await deps.events.audit(brandId, {
            action: 'HUMAN_HANDOFF_STARTED',
            targetType: 'CONVERSATION',
            targetId: conversation.conversationId,
          });
        }
        drafts.push({
          text: decision.reply.text,
          messageType: decision.reply.message_type,
          options: decision.reply.options?.map((o) => ({ optionId: o.option_id, label: o.label })),
          origin: 'AUTOMATED_REPLY' as const,
          messageKind: 'SESSION' as const,
          templateName: null,
          actionReference: recommendationId,
        });
      } else if (context.data.policy?.reply === 'WAIT_NOTICE') {
        drafts.push({
          text: WAIT_NOTICE,
          messageType: 'TEXT' as const,
          origin: 'AUTOMATED_REPLY' as const,
          messageKind: 'SESSION' as const,
          templateName: null,
          actionReference: null,
        });
      }
      context.data.drafts = drafts;
      return CONTINUE;
    },
  };

  /** 10. OUTBOUND — send through the conversation's MessagingProvider and persist. */
  const outbound: PipelineStage = {
    name: 'OUTBOUND',
    async run(context) {
      const conversation = need(context.data.conversation, 'conversation') as ConversationRecord;
      const customer = need(context.data.customer, 'customer');
      context.data.sent = [];
      for (const draft of context.data.drafts ?? []) {
        const { message, outbound: sent } = await sendAndPersist(deps, conversation, customer, draft);
        context.data.sent.push(message);
        context.outbound.push(sent);
      }
      return CONTINUE;
    },
  };

  /** 11. OUTCOME — M4: follow-up status after a reply (opt-out / handoff / replied). */
  const outcome: PipelineStage = {
    name: 'OUTCOME',
    async run(context) {
      await deps.onReply?.(context);
      return CONTINUE;
    },
  };

  return new ConversationPipeline([
    idempotency,
    identity,
    handshake,
    conversationState,
    policy,
    agent,
    guardrail,
    tools,
    persistence,
    outbound,
    outcome,
  ]);
}

async function titleOf(products: ProductRepository, brandId: string, intent: IntentRecord): Promise<string | null> {
  const product = (await products.listProducts(brandId)).find((p) => p.productId === intent.productId);
  return product?.title ?? null;
}
