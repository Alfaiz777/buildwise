/**
 * The ConversationPipeline stages (docs/03_TECH_ARCHITECTURE.md §8.2). M4: 1–5 and 9–10;
 * M5: 6 AGENT (context package → AgentRuntime with read tools → validated AgentDecision,
 * deterministic fallback on failure), 7 GUARDRAIL (re-verification against fresh data),
 * 8 TOOLS (guardrail-approved writes, then the reply from verified results). The fixed
 * order is enforced by ConversationPipeline.
 */
import { whatsappDisplayRef } from '../../domain/whatsappNumbers.js';
import { isWriteTool, type NearbyStoresOutput, type ProductContextOutput } from '../../domain/agentTools.js';
import { isRuleTap, parseOption, toOutboundOptions, type Reply } from '../../domain/agentReplies.js';
import type { AgentRuntimeName } from '../../domain/ai.js';
import { resolveMessagingSettings } from '../../domain/brandSettings.js';
import { compareWord, suggestedReplies } from '../../domain/quickReplies.js';
import type { Language } from '../../domain/conversationalReplies.js';

/** The verified alternative to compare with: its full title and the one word for the button. */
const compareWith = (bound: string | undefined, alternative: string | undefined, language: Language) => {
  const word = bound && alternative ? compareWord(bound, alternative, language) : null;
  return word && alternative ? { title: alternative, word } : null;
};
import { classifyTurn, detectLanguage } from '../../domain/conversationalReplies.js';
import { inServiceWindow } from '../../domain/conversationPolicy.js';
import {
  checkCancelProposal,
  checkOfferedStores,
  checkReservationProposal,
  isProposalLive,
  type PendingProposal,
} from '../../domain/guardrail.js';
import { namedShownStore, roundCoordinate } from '../../domain/locality.js';
import { canTransition, resolveReservationPolicy } from '../../domain/reservationStatus.js';
import { nearestOf, unmetDemandPayload } from '../../domain/unmetDemand.js';
import {
  decideInboundPolicy,
  isOptOutRequest,
  nextAiWindow,
  truncateInbound,
} from '../../domain/conversationPolicy.js';
import { buildFallbackDecision } from '../../domain/fallbackDecision.js';
import type { Logger } from '../../lib/logger.js';
import {
  checkIntentToken,
  extractIntentToken,
  hashIntentToken,
  MIN_PREFILL_MATCH_LENGTH,
  normalizePrefillText,
  pickPrefillMatch,
  prefillTextHash,
} from '../../domain/intentToken.js';
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
  ConnectionRepository,
  InventoryRepository,
  ProductRepository,
  StoreRepository,
} from '../../ports/repositories.js';
import { buildAgentContext } from '../agent/contextBuilder.js';
import { composeReply, type GuardrailOutcome } from '../agent/replyComposer.js';
import { AgentToolExecutor } from '../agent/toolExecutor.js';
import { createToolHandlers, DEFAULT_RADIUS_KM } from '../agent/tools.js';
import type { AttributionService } from '../attributionService.js';
import type { OnlineStockService } from '../onlineStock.js';
import type { OutcomeService } from '../outcomeService.js';
import type { ReservationService } from '../reservationService.js';
import { runAgentRuntime, AI_BACKUP_BUDGET_MS, AI_DECISION_BUDGET_MS } from './agentStage.js';
import { sendAndPersist, type OutboundDeps } from './outbound.js';
import {
  CONTINUE,
  ConversationPipeline,
  type PipelineContext,
  type PipelineData,
  type PipelineResult,
  type PipelineStage,
} from './pipeline.js';

export interface ConversationDeps extends OutboundDeps {
  brands: BrandRepository;
  products: ProductRepository;
  connections: ConnectionRepository;
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
  /**
   * The backup brain (docs/03 §16.2): when the configured runtime fails — too slow, an error,
   * or output still invalid after the repair — this runtime decides the same message with the
   * same tools. It also decides button taps directly (RULES_TAP), without calling the
   * configured runtime. The composition root sets it (the deterministic mock behind Gemini);
   * absent when the configured runtime is the mock itself.
   */
  backupAgent?: AgentRuntime;
  /** Codes and counts only; never message text. */
  logger?: Logger;
  /** Total AI decision budget per inbound message (docs/03 §16.1); injectable for tests. */
  aiBudgetMs?: number;
  /** M6: qs_ref on "Buy online" links, and the step-11 evidence re-check. */
  attribution?: AttributionService;
  outcomes?: OutcomeService;
  /** OUTCOME hook for the follow-up engine (M4 part 2). */
  onReply?: (context: PipelineContext) => Promise<void>;
  /** L2-Shopify: live online stock for "Buy online". */
  onlineStock?: Pick<OnlineStockService, 'canBuyOnline'>;
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
        context.inbound.channel === 'WHATSAPP'
          ? // L2-WhatsApp: the customer wrote to the brand's number first — recorded as consent (STOP still
            // opts out); the console label never shows the phone number.
            {
              consentState: 'OPTED_IN',
              shopifyCustomerId: null,
              displayRef: whatsappDisplayRef(context.inbound.externalCustomerRef),
            }
          : { consentState: 'UNKNOWN', shopifyCustomerId: null, displayRef: context.inbound.externalCustomerRef },
        now().toISOString(),
      );
      context.customerId = customer.customerId;
      context.data.customer = customer;
      context.data.customerCreated = created;
      return CONTINUE;
    },
  };

  /**
   * 3. HANDSHAKE — links the chat to the shopper's browsing intent, validate + consume + bind
   * in one transaction. A START_QWIKSPOT_<token> in the text (older links) is stripped and used;
   * otherwise (L4 plain prefill) the exact prefilled sentence is recognised by its hash.
   */
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
      const brandId = context.inbound.brandId;
      const customerId = need(context.customerId, 'customerId');

      let tokenHash: string | null = token ? hashIntentToken(token) : null;
      let boundBy = 'REF';
      if (!tokenHash) {
        // L4: the message the shopper sent is exactly a sentence Qwikspot prefilled (no visible code).
        if (normalizePrefillText(text).length < MIN_PREFILL_MATCH_LENGTH) return CONTINUE;
        const open = await deps.tokens.listOpenByTextHash(brandId, prefillTextHash(text), now().toISOString());
        const match = pickPrefillMatch(open, now());
        if (!match) {
          if (open.length > 1) {
            await deps.events.audit(brandId, {
              action: 'INTENT_TOKEN_REJECTED',
              targetType: 'CUSTOMER',
              targetId: customerId,
              result: 'DENIED',
              reasonCode: 'PREFILL_TEXT_AMBIGUOUS',
            });
          }
          return CONTINUE; // edited text or no recent prefill: the chat simply goes on
        }
        tokenHash = match.tokenHash;
        boundBy = 'TEXT_MATCH';
      }
      const result = await deps.tokens.consumeAndBind(tokenHash, brandId, customerId, now(), (t) =>
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
          reasonCode: boundBy,
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
          handoffAt: null,
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
      // The 12 s decision ceiling counts from here: building the context uses the model's time.
      const stageStarted = performance.now();
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
      context.data.agentContext = pkg.context;

      const input = {
        brandId: brand.brandId,
        customerId: customer.customerId,
        conversationId: conversation.conversationId,
        message: context.inbound,
        text: context.data.text ?? null,
        context: pkg.context,
        history: pkg.context.history,
        tools: toolDeclarations(AgentToolExecutor.DECIDE_TOOLS),
      };
      const budget = deps.aiBudgetMs ?? AI_DECISION_BUDGET_MS;
      const backupAgent = deps.backupAgent;
      // With a backup runtime, its time is kept inside the same total budget.
      const backupBudget = backupAgent ? Math.min(AI_BACKUP_BUDGET_MS, Math.floor(budget / 2)) : 0;
      // A button tap ("Pick up today", "Cancel reservation", …) is an unambiguous command: with a
      // model as the configured runtime, the deterministic rules decide it and the model is not
      // called — faster, and the same decision every time. The guardrail runs as for any decision.
      const content = context.inbound.content;
      // L5: so is a typed store name among the stores just shown ("I'll go to GlowUp" → its card).
      const shownStores = pkg.context.pending_proposal?.offered_store_names ?? [];
      const typedStore =
        content.type === 'TEXT' && shownStores.length > 0 && namedShownStore(input.text ?? '', shownStores) !== null;
      const ruleTap =
        Boolean(backupAgent) && ((content.type === 'INTERACTIVE_REPLY' && isRuleTap(content.optionId)) || typedStore);
      const agentStarted = performance.now();
      // The model gets what is left of the budget after the context build, minus the backup's slot.
      const modelBudget = Math.max(0, budget - backupBudget - Math.round(performance.now() - stageStarted));
      const result = ruleTap
        ? await runAgentRuntime(backupAgent!, input, tools, budget)
        : await runAgentRuntime(deps.agent, input, tools, modelBudget);
      const agentMs = Math.round(performance.now() - agentStarted);
      context.data.repaired = result.repaired;
      // The configured runtime failed: the backup runtime answers the same message with the
      // same tools, so a slow model still gets the customer a useful automatic reply.
      const backupStarted = performance.now();
      const backup =
        !result.ok && backupAgent && !ruleTap ? await runAgentRuntime(backupAgent, input, tools, backupBudget) : null;
      context.data.timing = {
        // A rule tap never reaches the configured runtime: its time is the rules' time.
        agentMs: ruleTap ? null : agentMs,
        backupMs: ruleTap ? agentMs : backup ? Math.round(performance.now() - backupStarted) : null,
      };
      if (!result.ok && backupAgent && !ruleTap) {
        deps.logger?.warn('agent.backup', {
          brand_id: brand.brandId,
          runtime: deps.runtimeName,
          backup_runtime: backupAgent.runtime,
          failure: result.reason,
          outcome: backup?.ok ? 'BACKUP_DECIDED' : 'DETERMINISTIC_FALLBACK',
        });
      }
      if (result.ok) {
        context.decision = result.decision;
        context.decisionSource = ruleTap ? 'RULES_TAP' : 'AGENT';
        context.data.fallbackReason = null;
      } else if (backup?.ok) {
        // Labelled with the runtime that really decided; the trace keeps why the first one failed.
        context.decision = backup.decision;
        context.decisionSource = 'AGENT_BACKUP';
        context.data.fallbackReason = result.reason;
      } else {
        context.decision = AgentDecisionSchema.parse(
          buildFallbackDecision({
            runtime: ruleTap ? backupAgent!.runtime : deps.runtimeName,
            // Last resort after the backup also failed: a slow model is not a reason to hand the
            // customer to a person — they are asked to try again and automated replies continue.
            handoffEnabled: messaging.handoffEnabled && !(backupAgent && result.reason === 'TIMEOUT'),
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
          actor: { type: 'AGENT', id: context.data.recommendationId ?? 'qwikspot' },
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
                : {
                    intent_type: decision.intent.intent_type,
                    // No intent bound yet: the product the customer asked a store for becomes one.
                    ...(!context.intentId && nba.variant_id ? { variant_id: nba.variant_id } : {}),
                  };
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
      const agentContext = context.data.agentContext;
      context.data.reply = await composeReply({
        decision,
        guardrail: outcome,
        tools,
        canHold: resolveReservationPolicy(brand.settings).reservationsEnabled,
        now: now(),
        ...(agentContext ? { conversation: { text: context.data.text ?? null, context: agentContext } } : {}),
        onRejected: (reason, turn) =>
          deps.logger?.warn('agent.reply_rejected', {
            brand_id: brand.brandId,
            runtime: decision.runtime,
            reason,
            turn_type: turn,
          }),
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
      await deps.events.audit(brandId, {
        action: 'CUSTOMER_MESSAGE_RECEIVED',
        targetType: 'CONVERSATION',
        targetId: conversation.conversationId,
        reasonCode: context.inbound.content.type,
        actor: { type: 'CUSTOMER', id: customerId },
      });
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
        await deps.events.audit(brandId, {
          action: 'AI_DECISION_RECORDED',
          targetType: 'RECOMMENDATION',
          targetId: recommendationId,
          result: outcome.status === 'BLOCKED' ? 'DENIED' : 'SUCCESS',
          reasonCode: `${nba.action}:${context.decisionSource}${outcome.reason ? `:${outcome.reason}` : ''}`,
          actor: { type: 'AGENT', id: decision.runtime },
        });
        await deps.events.record({
          ...base,
          eventType: 'AI_DECISION',
          source: 'QWIKSPOT',
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
            source: 'QWIKSPOT',
            entityReference: recommendationId,
            payload: unmetDemandPayload(f.output, now()),
            idempotencyKey: `STORE_RECOMMENDATION:UNMET:${recommendationId}:${variantId}`,
          });
        }

        // The hold offered in this reply becomes the conversation's pending proposal.
        let offered = (reply.options ?? [])
          .map((o) => parseOption(o.option_id))
          .flatMap((o) => (o.kind === 'HOLD' ? [o.storeId] : []));
        // L5: an area card names up to 3 stores but shows one Pick up button — all of them were offered.
        const areaSearch = [...finds]
          .reverse()
          .find((f) => f.output.area && f.output.eligible.some((s) => s.store_id === offered[0]));
        if (offered.length > 0 && areaSearch)
          offered = [...new Set([...offered, ...areaSearch.output.eligible.slice(0, 3).map((s) => s.store_id)])];
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
              source: 'QWIKSPOT',
              entityReference: recommendationId,
              payload: {
                kind: 'PROPOSED',
                variant_id: pending.variantId,
                sku: source.output.variant.sku,
                stores: offered,
                ...nearestOf(source.output),
              },
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

        // M6: a "Buy online" link carries a qs_ref that links a later order to this journey.
        const text = deps.attribution
          ? await deps.attribution.decorate(brandId, reply.text, {
              intentId: context.intentId,
              conversationId: conversation.conversationId,
              recommendationId,
            })
          : reply.text;
        // Parts only ever come from the deterministic composer, never from runtime output.
        const parts = 'parts' in reply ? (reply as Reply).parts : undefined;
        // L9: 2–3 suggested replies by rules (never model text), only where the turn has no buttons.
        const agentContext = context.data.agentContext;
        // The product this turn answered about (its lookup), else the bound intent's, with its verified alternative.
        const looked = [...tools.outputsOf<ProductContextOutput>('get_product_context')]
          .reverse()
          .find((c) => c.output.status === 'FOUND' && c.output.product)?.output;
        const [bound, alternative] = looked
          ? [looked.product!, ...looked.alternatives]
          : (agentContext?.products ?? []);
        const language = detectLanguage(context.data.text ?? '');
        const suggestions = suggestedReplies({
          action: nba.action,
          executed: executed?.type ?? null,
          hasButtons: (reply.options?.length ?? 0) > 0 || Boolean(parts?.ctaUrl),
          turn: nba.turn_type ?? classifyTurn(context.data.text),
          language,
          handedOff: Boolean(context.data.handoffStarted || context.data.conversation?.humanHandoff),
          handoffEnabled: resolveMessagingSettings(need(context.data.brand, 'brand').settings, '').handoffEnabled,
          productBound: Boolean(bound || context.data.intent?.productId),
          productTitle: bound?.title ?? null,
          compareWith: compareWith(bound?.title, alternative?.title, language),
          onlinePurchaseAvailable: Boolean(agentContext?.brand.online_purchase_available),
          storeSearchRan: finds.some((f) => f.output.status === 'OK'),
          storesFound: finds.some((f) => f.output.eligible.length > 0),
          windowOpen: inServiceWindow(context.data.conversation?.lastInboundAt ?? null, now()),
        });
        const options = reply.options?.length
          ? toOutboundOptions(reply.options)
          : suggestions.length
            ? suggestions
            : undefined;
        drafts.push({
          text,
          messageType: options?.length ? ('INTERACTIVE' as const) : ('TEXT' as const),
          options,
          parts,
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

  /** 11. OUTCOME — follow-up status after a reply (M4) and a re-check of stored purchase evidence (M6; never from AI output). */
  const outcome: PipelineStage = {
    name: 'OUTCOME',
    async run(context) {
      await deps.onReply?.(context);
      if (deps.outcomes && context.customerId) {
        await deps.outcomes.evaluateCustomer(context.inbound.brandId, context.customerId);
      }
      return CONTINUE;
    },
  };

  return new ConversationPipeline(
    [
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
    ],
    (result, totalMs) => deps.logger?.info('conversation.reply_timing', replyTiming(result, totalMs, deps.runtimeName)),
  );
}

/**
 * L5: one line per inbound message, without PII — how long the reply took and where the time
 * went: the model (gemini_ms), the rules / backup runtime (rules_ms), the tool calls, and which
 * path answered (RULES_TAP, GEMINI, MOCK, BACKUP, FALLBACK, or NONE when no decision was needed).
 */
export function replyTiming(result: PipelineResult, totalMs: number, runtimeName: string) {
  const { context } = result;
  const source = context.decisionSource;
  const path =
    source === 'RULES_TAP'
      ? 'RULES_TAP'
      : source === 'AGENT'
        ? runtimeName === 'ADK_GEMINI'
          ? 'GEMINI'
          : 'MOCK'
        : source === 'AGENT_BACKUP'
          ? 'BACKUP'
          : source === 'DETERMINISTIC_FALLBACK'
            ? 'FALLBACK'
            : 'NONE';
  const timing = context.data.timing;
  return {
    brand_id: context.inbound.brandId,
    channel: context.inbound.channel,
    message_type: context.inbound.content.type,
    path,
    backup_used: source === 'AGENT_BACKUP' || (source === 'DETERMINISTIC_FALLBACK' && timing?.backupMs != null),
    total_ms: totalMs,
    gemini_ms: runtimeName === 'ADK_GEMINI' ? (timing?.agentMs ?? null) : null,
    rules_ms: runtimeName === 'ADK_GEMINI' ? (timing?.backupMs ?? null) : (timing?.agentMs ?? null),
    tool_calls: context.data.tools?.calls.length ?? 0,
    action: context.decision?.next_best_action.action ?? null,
    stopped_at: result.stoppedAt?.stage ?? null,
  };
}
