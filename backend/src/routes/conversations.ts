import { Router } from 'express';
import type {
  ConversationDetail,
  ConversationQueryService,
  IntentView,
} from '../application/conversationQueryService.js';
import type { FollowUpService } from '../application/followUpService.js';
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
      }
    : null,
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

export function brandConversationsRouter(queries: ConversationQueryService, followUps: FollowUpService): Router {
  const router = Router();

  /**
   * Processes the brand's due follow-ups now (docs/00 §11.8 Change 11, D5). Idempotent: a
   * follow-up is claimed atomically, so running this twice never sends twice. In gcp the
   * same endpoint will be called by Cloud Scheduler with an OIDC identity (L-phase).
   */
  router.post('/follow-ups/process-due', async (_req, res) => {
    const result = await followUps.processDue(getBrandPrincipal(res).brandId);
    res.json({
      abandoned: result.abandoned,
      sent: result.sent,
      suppressed: result.suppressed,
      reservations_expired: result.reservationsExpired,
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
        last_message_at: r.conversation.lastMessageAt,
        last_inbound_at: r.conversation.lastInboundAt,
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
      last_inbound_at: d.conversation.lastInboundAt,
      brand_display_name: d.brandDisplayName,
      intent: d.intent ? intentJson(d.intent) : null,
      web_events: d.webEvents.map((e) => ({ event_type: e.eventType, at: e.at, details: e.payload })),
      messages: d.messages.map(messageJson),
      recommendations: d.recommendations.map(recommendationJson),
    });
  });

  router.get('/intents', async (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const status = typeof req.query.follow_up_status === 'string' ? req.query.follow_up_status : undefined;
    const intents = await queries.listIntents(getBrandPrincipal(res).brandId, { type, followUpStatus: status });
    res.json({ intents: intents.map(intentJson) });
  });

  return router;
}
