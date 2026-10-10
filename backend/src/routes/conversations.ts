import { Router } from 'express';
import { z } from 'zod';
import type {
  ConversationDetail,
  ConversationQueryService,
  IntentView,
} from '../application/conversationQueryService.js';
import type { FollowUpService } from '../application/followUpService.js';
import { HUMAN_REPLY_MAX, type HandoffService } from '../application/handoffService.js';
import { messageJson, type SimulatorService } from '../application/simulatorService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { AppError, Errors } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import type { FollowUpState } from '../ports/conversationRepositories.js';

/**
 * Brand Console conversation routes, BRAND_ADMIN only (mounted behind requireScope('BRAND')):
 *   /api/channels/simulator/*      docs/06 §14.2 (the simulator acts for the caller's brand)
 *   /api/brand/conversations[/:id] docs/11 §4 "Conversations & intents"
 *   /api/brand/intents             every intent, anonymous ones included, with the reason
 * Another brand's conversation is 404.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HumanReply = z.object({ text: z.string().trim().min(1).max(HUMAN_REPLY_MAX) }).strict();

const idParam = (value: unknown) => {
  if (typeof value !== 'string' || !ID.test(value)) throw Errors.notFound();
  return value;
};

export const followUpJson = (f: FollowUpState | null) =>
  f && {
    decision: f.decision,
    reason: f.reason,
    status: f.status,
    evaluated_at: f.evaluatedAt,
    due_at: f.dueAt,
    priority: f.priority,
    message_kind: f.messageKind,
    template_name: f.templateName,
    sent_at: f.sentAt,
  };

export const intentJson = (v: IntentView) => ({
  intent_id: v.intent.intentId,
  who: v.who,
  anonymous: v.anonymous,
  intent_stage: v.intent.stage,
  intent_strength: v.intent.strength,
  intent_type: v.intent.type,
  status: v.intent.status,
  product_title: v.productTitle,
  variant_title: v.variantTitle,
  matched_category: v.intent.matchedCategory,
  last_event: v.intent.lastEvent,
  last_event_at: v.intent.lastEventAt,
  detected_at: v.intent.detectedAt,
  token_consumed: !!v.intent.tokenConsumedAt,
  follow_up: followUpJson(v.intent.followUp),
});

const recommendationJson = (r: ConversationDetail['recommendations'][number]) => ({
  recommendation_id: r.recommendationId,
  action: r.action,
  runtime: r.runtime,
  decision_source: r.decisionSource,
  guardrail_status: r.guardrailStatus,
  guardrail_reason: r.guardrailReason,
  rationale_summary: r.rationaleSummary,
  target_store_id: r.targetStoreId,
  target_variant_id: r.targetVariantId,
  proposed_at: r.proposedAt,
  trace: r.trace,
  reservation: r.reservation
    ? {
        reservation_id: r.reservation.reservationId,
        status: r.reservation.status,
        store_id: r.reservation.storeId,
        store_name: r.reservation.storeName,
        pickup_code: r.reservation.pickupCode,
        expires_at: r.reservation.expiresAt,
        quantity: r.reservation.quantity,
        product_title: r.reservation.productTitle,
        variant_title: r.reservation.variantTitle,
        status_history: r.reservation.statusHistory.map((s) => ({
          status: s.status,
          at: s.at,
          ...(s.by !== undefined ? { by: s.by } : {}),
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        })),
      }
    : null,
});

const outcomeJson = (o: ConversationDetail['outcomes'][number]) => ({
  purchase_type: o.purchaseType,
  evidence: o.evidence,
  channel: o.channel,
  store_id: o.storeId,
  store_name: o.storeName,
  reservation_id: o.reservationId,
  value: o.value,
  currency: o.currency,
  timestamp: o.timestamp,
  cancelled_at: o.cancelledAt ?? null,
});

export function simulatorRouter(simulator: SimulatorService, queries: ConversationQueryService): Router {
  const router = Router();
  const perUser = new RateLimiter(30, 60_000);

  router.post('/messages', async (req, res) => {
    const principal = getBrandPrincipal(res);
    if (!simulatorEnabled(simulator)) throw simulatorDisabled();
    if (!perUser.hit(principal.userId))
      throw new AppError(429, 'RATE_LIMITED', 'Too many messages. Try again later.', true);
    res.json(await simulator.handle(principal, req.body));
  });

  router.get('/conversations/:conversationId/messages', async (req, res) => {
    if (!simulatorEnabled(simulator)) throw simulatorDisabled();
    const after = typeof req.query.after === 'string' && MESSAGE_ID.test(req.query.after) ? req.query.after : undefined;
    const messages = await queries.simulatorMessages(
      getBrandPrincipal(res).brandId,
      idParam(req.params.conversationId),
      after,
    );
    res.json({ messages: messages.map(messageJson) });
  });

  return router;
}

const MESSAGE_ID = /^msg_[0-9a-z]{9,40}$/;
const simulatorEnabled = (s: SimulatorService) => s.enabled;
const simulatorDisabled = () => new AppError(404, 'CHANNEL_DISABLED', 'The simulator channel is not enabled.');

export function brandConversationsRouter(
  queries: ConversationQueryService,
  followUps: FollowUpService,
  handoff: HandoffService,
): Router {
  const router = Router();

  /**
   * Processes the brand's due follow-ups now (docs/00 §11.8 Change 11, D5). Idempotent: a
   * follow-up is claimed atomically, so running this twice never sends twice. In gcp the
   * same endpoint will be called by Cloud Scheduler with an OIDC identity (L-phase).
   */
  router.post('/follow-ups/process-due', async (_req, res) => {
    const principal = getBrandPrincipal(res);
    const result = await followUps.processDue(principal.brandId, { type: 'USER', id: principal.userId });
    res.json({
      abandoned: result.abandoned,
      sent: result.sent,
      suppressed: result.suppressed,
      reservations_expired: result.reservationsExpired,
      outcomes_closed: result.outcomesClosed,
      results: result.results.map((r) => ({ intent_id: r.intentId, outcome: r.outcome, reason: r.reason })),
    });
  });

  router.get('/conversations', async (_req, res) => {
    const rows = await queries.listConversations(getBrandPrincipal(res).brandId);
    res.json({
      conversations: rows.map((r) => ({
        conversation_id: r.conversation.conversationId,
        customer_ref: r.customerRef,
        channel: r.conversation.channel,
        status: r.conversation.status,
        human_handoff: r.conversation.humanHandoff,
        handoff_at: r.conversation.handoffAt,
        last_message_at: r.conversation.lastMessageAt,
        last_inbound_at: r.conversation.lastInboundAt,
        demo_history: r.conversation.demoHistory === true,
        intent: r.intent ? intentJson(r.intent) : null,
      })),
    });
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    const d = await queries.conversationDetail(getBrandPrincipal(res).brandId, idParam(req.params.conversationId));
    res.json({
      conversation_id: d.conversation.conversationId,
      customer_ref: d.customerRef,
      channel: d.conversation.channel,
      status: d.conversation.status,
      human_handoff: d.conversation.humanHandoff,
      handoff_at: d.conversation.handoffAt,
      last_inbound_at: d.conversation.lastInboundAt,
      brand_display_name: d.brandDisplayName,
      demo_history: d.conversation.demoHistory === true,
      intent: d.intent ? intentJson(d.intent) : null,
      web_events: d.webEvents.map((e) => ({ event_type: e.eventType, at: e.at, details: e.payload })),
      messages: d.messages.map(messageJson),
      recommendations: d.recommendations.map(recommendationJson),
      outcomes: d.outcomes.map(outcomeJson),
    });
  });

  /** M6 handoff queue: reply as a person (origin HUMAN_AGENT; opt-out and the 24 h window still apply). */
  router.post('/conversations/:conversationId/replies', async (req, res) => {
    const body = HumanReply.safeParse(req.body);
    if (!body.success) throw Errors.invalidRequest('Write a reply of up to 1,000 characters.');
    const message = await handoff.reply(getBrandPrincipal(res), idParam(req.params.conversationId), body.data.text);
    res.status(201).json(messageJson(message));
  });

  /** M6: "Resolve and return to assistant" — the next customer message gets automated replies again. */
  router.post('/conversations/:conversationId/resolve', async (req, res) => {
    await handoff.resolve(getBrandPrincipal(res), idParam(req.params.conversationId));
    res.json({ human_handoff: false });
  });

  router.get('/intents', async (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const status = typeof req.query.follow_up_status === 'string' ? req.query.follow_up_status : undefined;
    const intents = await queries.listIntents(getBrandPrincipal(res).brandId, { type, followUpStatus: status });
    res.json({ intents: intents.map(intentJson) });
  });

  return router;
}
