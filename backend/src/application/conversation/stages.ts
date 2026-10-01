/**
 * The ConversationPipeline stages (docs/03_TECH_ARCHITECTURE.md §8.2). M4: 1–5 and 9–10;
 * M5: 6 AGENT (context package → AgentRuntime with read tools → validated AgentDecision,
 * deterministic fallback on failure), 7 GUARDRAIL (re-verification against fresh data),
 * 8 TOOLS (guardrail-approved writes, then the reply from verified results). The fixed
 * order is enforced by ConversationPipeline.
 */
import { isWriteTool, type NearbyStoresOutput } from '../../domain/agentTools.js';
import { parseOption } from '../../domain/agentReplies.js';
import type { AgentRuntimeName } from '../../domain/ai.js';
import { resolveMessagingSettings } from '../../domain/brandSettings.js';
import {
  checkCancelProposal,
  checkOfferedStores,
  checkReservationProposal,
  isProposalLive,
  type PendingProposal,
} from '../../domain/guardrail.js';
import { roundCoordinate } from '../../domain/locality.js';
import { canTransition, resolveReservationPolicy } from '../../domain/reservationStatus.js';
import { unmetDemandPayload } from '../../domain/unmetDemand.js';
import {
  decideInboundPolicy,
  isOptOutRequest,
  nextAiWindow,
  truncateInbound,
} from '../../domain/conversationPolicy.js';
import { buildFallbackDecision } from '../../domain/fallbackDecision.js';
import { checkIntentToken, extractIntentToken, hashIntentToken } from '../../domain/intentToken.js';
import { newId, sortableId } from '../../lib/ids.js';
import { AgentDecisionSchema, type AgentRuntime } from '../../ports/agent.js';
import { toolDeclarations } from '../../ports/agentTools.js';
import type {
  ConversationRecord,
  ConversationRepository,
  CustomerRepository,
  IntentRepository,
  IntentTokenRepository,
  RecommendationRepository,
  VisitorLinkRepository,
  WebhookReceiptRepository,
} from '../../ports/conversationRepositories.js';
import type {
  BrandRepository,
  InventoryRepository,
  ProductRepository,
  StoreRepository,
} from '../../ports/repositories.js';
import { buildAgentContext } from '../agent/contextBuilder.js';
import { composeReply, type GuardrailOutcome } from '../agent/replyComposer.js';
import { AgentToolExecutor } from '../agent/toolExecutor.js';
import { createToolHandlers, DEFAULT_RADIUS_KM } from '../agent/tools.js';
import type { ReservationService } from '../reservationService.js';
import { runAgentRuntime, AI_DECISION_BUDGET_MS } from './agentStage.js';
import { sendAndPersist, type OutboundDeps } from './outbound.js';
import {
  CONTINUE,
  ConversationPipeline,
  type PipelineContext,
  type PipelineData,
  type PipelineStage,
} from './pipeline.js';

export interface ConversationDeps extends OutboundDeps {
  brands: BrandRepository;
  products: ProductRepository;
  customers: CustomerRepository;
  visitors: VisitorLinkRepository;
  intents: IntentRepository;
  tokens: IntentTokenRepository;
  recommendations: RecommendationRepository;
  receipts: WebhookReceiptRepository;
  stores: StoreRepository;
  inventory: InventoryRepository;
  reservations: ReservationService;
  /** The configured AgentRuntime (MOCK locally; ADK_GEMINI from L1). */
  agent: AgentRuntime;
  /** The configured AgentRuntime's name (recorded on every decision). */
  runtimeName: AgentRuntimeName;
  /** Total AI decision budget per inbound message (docs/03 §16.1); injectable for tests. */
  aiBudgetMs?: number;
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
  const toolHandlers = createToolHandlers({ ...deps, events: deps.events, now });

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
          pendingProposal: null,
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
      if (content.type === 'LOCATION') {
        // A shared location is kept at ~1 km (2 decimal places) for store search only.
        const lastLocation = {
          latitude: roundCoordinate(content.latitude),
          longitude: roundCoordinate(content.longitude),
          source: 'SHARED' as const,
          locality: null,
          at,
        };
        await deps.customers.update(brandId, customerId, { lastLocation });
        context.data.customer = { ...need(context.data.customer, 'customer'), lastLocation };
      }
      if (content.type === 'INTERACTIVE_REPLY') {
        // Store the tapped option's label, so the conversation history reads naturally.
        const previous = (await deps.conversations.listMessages(brandId, conversation.conversationId))
          .filter((m) => m.direction === 'OUTBOUND' && m.options)
          .at(-1);
        context.data.text = previous?.options?.find((o) => o.optionId === content.optionId)?.label ?? null;
      }
      const inboundMessageId = sortableId('msg', now());
      await deps.conversations.addMessage({
        messageId: inboundMessageId,
        brandId,
        conversationId: conversation.conversationId,
        direction: 'INBOUND',
        messageType: content.type,
        text: content.type === 'LOCATION' ? null : (context.data.text ?? (content.type === 'TEXT' ? '' : null)),
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

  /** 6. AGENT — context package → AgentRuntime (read tools only) → validated AgentDecision. */
  const agent: PipelineStage = {
    name: 'AGENT',
    async run(context) {
      if (context.data.policy?.reply !== 'AUTOMATED') return CONTINUE;
      const brand = need(context.data.brand, 'brand');
      const customer = need(context.data.customer, 'customer');
      const conversation = need(context.data.conversation, 'conversation');
      const messaging = resolveMessagingSettings(brand.settings, brand.name);
      const recommendationId = sortableId('rec', now());
      context.data.recommendationId = recommendationId;

      const tools = new AgentToolExecutor(
        toolHandlers,
        {
          brandId: brand.brandId,
          customerId: customer.customerId,
          conversationId: conversation.conversationId,
          intentId: context.intentId,
          recommendationId,
        },
        (tool, reason) =>
          deps.events.audit(brand.brandId, {
            action: 'AI_TOOL_CALL_BLOCKED',
            targetType: 'TOOL',
            targetId: tool,
            result: 'DENIED',
            reasonCode: reason,
            actor: { type: 'AGENT', id: recommendationId },
          }),
      );
      context.data.tools = tools;
      const pkg = await buildAgentContext(deps, {
        brand,
        customer,
        conversation,
        intent: context.data.intent ?? null,
        now: now(),
      });
      context.data.contextHash = pkg.hash;
      context.data.contextSummary = pkg.summary;

      const result = await runAgentRuntime(
        deps.agent,
        {
          brandId: brand.brandId,
          customerId: customer.customerId,
          conversationId: conversation.conversationId,
          message: context.inbound,
          text: context.data.text ?? null,
          context: pkg.context,
          history: pkg.context.history,
          tools: toolDeclarations(AgentToolExecutor.DECIDE_TOOLS),
        },
        tools,
        deps.aiBudgetMs ?? AI_DECISION_BUDGET_MS,
      );
      context.data.repaired = result.repaired;
      if (result.ok) {
        context.decision = result.decision;
        context.decisionSource = 'AGENT';
        context.data.fallbackReason = null;
      } else {
        context.decision = AgentDecisionSchema.parse(
          buildFallbackDecision({
            runtime: deps.runtimeName,
            handoffEnabled: messaging.handoffEnabled,
            brandName: messaging.displayName,
            intentType: context.data.intent?.type ?? null,
            failure: result.reason,
          }),
        );
        context.decisionSource = 'DETERMINISTIC_FALLBACK';
        context.data.fallbackReason = result.reason;
      }
      return CONTINUE;
    },
  };

  /** 7. GUARDRAIL — re-verify the proposed action against FRESH data before anything is written. */
  const guardrail: PipelineStage = {
    name: 'GUARDRAIL',
    async run(context) {
      const decision = context.decision;
      if (!decision) return CONTINUE;
      const brand = need(context.data.brand, 'brand');
      const conversation = need(context.data.conversation, 'conversation');
      const customer = need(context.data.customer, 'customer');
      const tools = need(context.data.tools, 'tools');
      const nba = decision.next_best_action;
      const writes = decision.required_tools.filter(isWriteTool);
      const outcome: GuardrailOutcome = {
        status: 'ALLOWED',
        reason: null,
        checked: null,
        storeId: nba.store_id ?? null,
        storeName: null,
        variantId: nba.variant_id ?? null,
      };

      if (writes.includes('create_reservation') || nba.action === 'STORE_RESERVATION') {
        outcome.checked = 'CREATE_RESERVATION';
        const store = nba.store_id ? await deps.stores.get(brand.brandId, nba.store_id) : null;
        outcome.storeName = store?.storeName ?? null;
        const row =
          store && nba.variant_id
            ? (await deps.inventory.listByStore(brand.brandId, store.storeId)).find(
                (r) => r.variantId === nba.variant_id,
              )
            : undefined;
        const last = customer.lastLocation;
        const verdict = checkReservationProposal({
          proposal: { storeId: nba.store_id ?? null, variantId: nba.variant_id ?? null, quantity: nba.quantity ?? 1 },
          pending: conversation.pendingProposal,
          store,
          inventory: row ? { quantity: row.quantity, reservedQuantity: row.reservedQuantity } : null,
          policy: resolveReservationPolicy(brand.settings),
          origin: last ? { latitude: last.latitude, longitude: last.longitude } : null,
          radiusKm: DEFAULT_RADIUS_KM,
          now: now(),
        });
        if (verdict.status === 'BLOCKED') Object.assign(outcome, { status: 'BLOCKED', reason: verdict.reason });
      } else if (writes.includes('cancel_reservation')) {
        outcome.checked = 'CANCEL_RESERVATION';
        const reservation = nba.reservation_id ? await deps.reservations.get(brand.brandId, nba.reservation_id) : null;
        const verdict = checkCancelProposal({
          reservationId: nba.reservation_id ?? null,
          reservation,
          customerId: customer.customerId,
          cancellable: !!reservation && canTransition(reservation.status, 'CANCELLED'),
        });
        if (verdict.status === 'BLOCKED') Object.assign(outcome, { status: 'BLOCKED', reason: verdict.reason });
      } else {
        const offered = (decision.reply.options ?? [])
          .map((o) => parseOption(o.option_id))
          .flatMap((o) => (o.kind === 'HOLD' ? [o.storeId] : []));
        if (offered.length > 0) {
          outcome.checked = 'OFFERED_STORES';
          const eligible = new Set(
            tools
              .outputsOf<NearbyStoresOutput>('find_nearby_stores')
              .flatMap((f) => f.output.eligible.map((s) => s.store_id)),
          );
          const verdict = checkOfferedStores(offered, eligible);
          if (verdict.status === 'BLOCKED') {
            const bad = offered.find((id) => !eligible.has(id)) ?? null;
            Object.assign(outcome, { status: 'BLOCKED', reason: verdict.reason, storeId: bad });
          }
        }
      }

      context.data.guardrail = outcome;
      context.guardrailStatus = outcome.status;
      if (outcome.status === 'BLOCKED') {
        await deps.events.audit(brand.brandId, {
          action: 'AI_ACTION_BLOCKED',
          targetType: outcome.checked === 'CANCEL_RESERVATION' ? 'RESERVATION' : 'STORE',
          targetId: (outcome.checked === 'CANCEL_RESERVATION' ? nba.reservation_id : outcome.storeId) ?? 'unknown',
          result: 'DENIED',
          reasonCode: outcome.reason,
          actor: { type: 'AGENT', id: context.data.recommendationId ?? 'buildwise' },
        });
      }
      return CONTINUE;
    },
  };

  /** 8. TOOLS — execute the guardrail-approved writes, then build the reply from verified results. */
  const toolsStage: PipelineStage = {
    name: 'TOOLS',
    async run(context) {
      const decision = context.decision;
      if (!decision) return CONTINUE;
      const brand = need(context.data.brand, 'brand');
      const tools = need(context.data.tools, 'tools');
      const outcome = need(context.data.guardrail, 'guardrail');
      const nba = decision.next_best_action;
      tools.enterExecutePhase();

      const writes = [...new Set(decision.required_tools.filter(isWriteTool))];
      const blocked = outcome.status === 'BLOCKED';
      let executed: PipelineData['executedAction'] = null;
      for (const tool of writes) {
        if (blocked && (tool === 'create_reservation' || tool === 'cancel_reservation')) continue;
        const input =
          tool === 'create_reservation'
            ? { store_id: nba.store_id, variant_id: nba.variant_id, quantity: nba.quantity ?? 1 }
            : tool === 'cancel_reservation'
              ? { reservation_id: nba.reservation_id }
              : tool === 'request_human_handoff'
                ? { reason: nba.reason.slice(0, 200) || 'handoff' }
                : { intent_type: decision.intent.intent_type };
        const result = await tools.execute({ tool, input });
        const reservationId =
          (result.output as { reservation?: { reservation_id: string } | null } | null)?.reservation?.reservation_id ??
          null;
        if (tool === 'create_reservation' || tool === 'cancel_reservation' || tool === 'request_human_handoff') {
          executed =
            result.status === 'EXECUTED'
              ? {
                  type:
                    tool === 'create_reservation'
                      ? 'RESERVATION_CREATED'
                      : tool === 'cancel_reservation'
                        ? 'RESERVATION_CANCELLED'
                        : 'HUMAN_HANDOFF',
                  tool,
                  status: result.status,
                  reasonCode: null,
                  reservationId,
                }
              : { type: 'NONE', tool, status: result.status, reasonCode: result.reasonCode, reservationId: null };
        }
        if (tool === 'request_human_handoff' && result.status === 'EXECUTED') {
          context.data.handoffStarted = true;
          context.data.conversation = { ...need(context.data.conversation, 'conversation'), humanHandoff: true };
        }
      }
      context.data.executedAction = executed;
      context.data.reply = await composeReply({
        decision,
        guardrail: outcome,
        tools,
        canHold: resolveReservationPolicy(brand.settings).reservationsEnabled,
        now: now(),
      });
      return CONTINUE;
    },
  };

  /** 9. PERSISTENCE — recommendation + trace, proposal state, CommerceEvents, AuditEvents. */
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
        const recommendationId = need(context.data.recommendationId, 'recommendationId');
        const tools = need(context.data.tools, 'tools');
        const outcome = need(context.data.guardrail, 'guardrail');
        const reply = context.data.reply ?? decision.reply;
        const nba = decision.next_best_action;
        const finds = tools.outputsOf<NearbyStoresOutput>('find_nearby_stores');
        const executed = context.data.executedAction ?? null;

        await deps.recommendations.create({
          recommendationId,
          brandId,
          customerId,
          conversationId: conversation.conversationId,
          intentId: context.intentId,
          action: nba.action,
          targetStoreId: nba.store_id ?? null,
          targetVariantId: nba.variant_id ?? context.data.intent?.variantId ?? null,
          confidence: decision.intent.confidence,
          rationaleSummary: nba.reason,
          evidenceReferences: tools.calls.filter((c) => c.status === 'EXECUTED').map((c) => c.callId),
          runtime: decision.runtime,
          decisionSource: context.decisionSource ?? 'DETERMINISTIC_FALLBACK',
          guardrailStatus: context.guardrailStatus ?? 'ALLOWED',
          guardrailReason: outcome.reason,
          proposedAt: at,
          trace: {
            context_hash: context.data.contextHash ?? '',
            context_summary: context.data.contextSummary ?? {},
            tool_calls: tools.trace,
            eligible: finds.flatMap((f) =>
              f.output.eligible.map((s) => ({
                store_id: s.store_id,
                store_name: s.store_name,
                distance_km: s.distance_km,
                variant_id: f.output.variant?.variant_id ?? '',
              })),
            ),
            excluded: finds.flatMap((f) =>
              f.output.excluded.map((x) => ({
                store_id: x.store_id,
                store_name: x.store_name,
                reason: x.reason,
                distance_km: x.distance_km,
                variant_id: f.output.variant?.variant_id ?? '',
              })),
            ),
            guardrail: { status: outcome.status, reason_code: outcome.reason, checked: outcome.checked },
            executed_action: executed
              ? {
                  tool: executed.tool,
                  status: executed.status,
                  reason_code: executed.reasonCode,
                  reservation_id: executed.reservationId,
                }
              : null,
            repaired: context.data.repaired ?? false,
            fallback_reason: context.data.fallbackReason ?? null,
          },
        });
        await deps.events.record({
          ...base,
          eventType: 'AI_DECISION',
          source: 'BUILDWISE',
          entityReference: recommendationId,
          payload: {
            action: nba.action,
            runtime: decision.runtime,
            decision_source: context.decisionSource,
            guardrail_status: outcome.status,
            guardrail_reason: outcome.reason,
          },
          idempotencyKey: `AI_DECISION:${recommendationId}`,
        });

        // Unmet local demand: no eligible store for a requested variant (never for "other stores").
        const unmet = new Set<string>();
        for (const f of finds) {
          const variantId = f.output.variant?.variant_id;
          if (f.output.status !== 'OK' || f.output.eligible.length > 0 || f.output.skipped_stores.length > 0) continue;
          if (!variantId || unmet.has(variantId)) continue;
          unmet.add(variantId);
          await deps.events.record({
            ...base,
            eventType: 'STORE_RECOMMENDATION',
            source: 'BUILDWISE',
            entityReference: recommendationId,
            payload: unmetDemandPayload(f.output, now()),
            idempotencyKey: `STORE_RECOMMENDATION:UNMET:${recommendationId}:${variantId}`,
          });
        }

        // The hold offered in this reply becomes the conversation's pending proposal.
        const offered = (reply.options ?? [])
          .map((o) => parseOption(o.option_id))
          .flatMap((o) => (o.kind === 'HOLD' ? [o.storeId] : []));
        let pending: PendingProposal | null | undefined;
        if (executed?.type === 'RESERVATION_CREATED') pending = null;
        else if (offered.length > 0) {
          const source = [...finds].reverse().find((f) => f.output.eligible.some((s) => s.store_id === offered[0]));
          if (source?.output.variant) {
            const holdMinutes = resolveReservationPolicy(need(context.data.brand, 'brand').settings).holdMinutes;
            pending = {
              storeId: offered[0]!,
              variantId: source.output.variant.variant_id,
              quantity: 1,
              proposedAt: at,
              expiresAt: new Date(now().getTime() + holdMinutes * 60_000).toISOString(),
              offeredStores: offered,
            };
            await deps.events.record({
              ...base,
              eventType: 'STORE_RECOMMENDATION',
              source: 'BUILDWISE',
              entityReference: recommendationId,
              payload: { kind: 'PROPOSED', variant_id: pending.variantId, stores: offered },
              idempotencyKey: `STORE_RECOMMENDATION:PROPOSED:${recommendationId}`,
            });
          }
        } else if (conversation.pendingProposal && !isProposalLive(conversation.pendingProposal, now())) pending = null;
        if (pending !== undefined) {
          await deps.conversations.update(brandId, conversation.conversationId, {
            pendingProposal: pending,
            updatedAt: at,
          });
          context.data.conversation = { ...conversation, pendingProposal: pending };
        }

        // An area name resolved to a store locality becomes the customer's (approximate) location.
        const byArea = finds.find((f) => f.output.origin?.source === 'LOCALITY' && 'area' in f.input);
        if (byArea?.output.origin_point) {
          await deps.customers.update(brandId, customerId, {
            lastLocation: {
              latitude: byArea.output.origin_point.latitude,
              longitude: byArea.output.origin_point.longitude,
              source: 'LOCALITY',
              locality: byArea.output.origin?.locality ?? null,
              at,
            },
          });
        }

        drafts.push({
          text: reply.text,
          messageType: reply.options?.length ? ('INTERACTIVE' as const) : ('TEXT' as const),
          options: reply.options?.map((o) => ({ optionId: o.option_id, label: o.label })),
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
    toolsStage,
    persistence,
    outbound,
    outcome,
  ]);
}
