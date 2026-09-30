import type { DecisionSource, GuardrailStatus } from '../../domain/ai.js';
import type { InboundPolicyDecision } from '../../domain/conversationPolicy.js';
import type { AgentDecision } from '../../ports/agent.js';
import type {
  ConversationRecord,
  CustomerRecord,
  IntentRecord,
  MessageRecord,
} from '../../ports/conversationRepositories.js';
import type { InboundMessage, OutboundMessage } from '../../ports/messaging.js';
import type { BrandRecord } from '../../ports/repositories.js';
import type { OutboundDraft } from './outbound.js';

/**
 * The ONE conversation pipeline for every customer channel
 * (docs/03_TECH_ARCHITECTURE.md §8.2):
 *
 *   WhatsApp webhook ─┐
 *                     ├─► ConversationPipeline.handleInbound(InboundMessage)
 *   Simulator channel ┘
 *
 * The stage order is fixed here and cannot be changed by wiring. M2 provides the
 * structure; the stages are implemented in M4 (1–5, 9–10), M5 (6–8) and M6 (11).
 */
export const PIPELINE_STAGES = [
  'IDEMPOTENCY',
  'IDENTITY',
  'HANDSHAKE',
  'CONVERSATION_STATE',
  'POLICY',
  'AGENT',
  'GUARDRAIL',
  'TOOLS',
  'PERSISTENCE',
  'OUTBOUND',
  'OUTCOME',
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGES)[number];

/** State the M4+ stages share (each stage fills its part; later stages read it). */
export interface PipelineData {
  receiptKey?: string;
  /** Set by IDEMPOTENCY for a duplicate delivery: the original result, if already stored. */
  duplicate?: { status: 'PROCESSING' | 'PROCESSED'; result: unknown };
  brand?: BrandRecord;
  customer?: CustomerRecord;
  customerCreated?: boolean;
  conversation?: ConversationRecord;
  conversationCreated?: boolean;
  /** Inbound text after token stripping and truncation (null for non-text content). */
  text?: string | null;
  inboundMessageId?: string;
  /** The intent bound by the handshake or already current on the conversation. */
  intent?: IntentRecord | null;
  policy?: InboundPolicyDecision;
  recommendationId?: string;
  handoffStarted?: boolean;
  /** Replies decided in this run, sent by OUTBOUND. */
  drafts?: OutboundDraft[];
  /** Outbound messages persisted by OUTBOUND in this run. */
  sent?: MessageRecord[];
}

/** Mutable state passed from stage to stage for one inbound message. */
export interface PipelineContext {
  readonly inbound: InboundMessage;
  customerId: string | null;
  conversationId: string | null;
  intentId: string | null;
  decision: AgentDecision | null;
  decisionSource: DecisionSource | null;
  guardrailStatus: GuardrailStatus | null;
  outbound: OutboundMessage[];
  data: PipelineData;
}

/** `stop` ends the run early, e.g. a duplicate delivery or a policy block. */
export type StageOutcome = { readonly stop: false } | { readonly stop: true; readonly reason: string };

export const CONTINUE: StageOutcome = { stop: false };

export interface PipelineStage {
  readonly name: PipelineStageName;
  run(context: PipelineContext): Promise<StageOutcome>;
}

export interface PipelineResult {
  context: PipelineContext;
  completedStages: PipelineStageName[];
  stoppedAt: { stage: PipelineStageName; reason: string } | null;
}

export class ConversationPipeline {
  private readonly stages: readonly PipelineStage[];

  /** Requires exactly one stage per name, in the approved order. */
  constructor(stages: readonly PipelineStage[]) {
    const names = stages.map((stage) => stage.name);
    const expected = PIPELINE_STAGES.join(' → ');
    if (names.join(' → ') !== expected) {
      throw new Error(`ConversationPipeline stages must be exactly: ${expected}`);
    }
    this.stages = stages;
  }

  async handleInbound(inbound: InboundMessage): Promise<PipelineResult> {
    const context: PipelineContext = {
      inbound,
      customerId: null,
      conversationId: null,
      intentId: null,
      decision: null,
      decisionSource: null,
      guardrailStatus: null,
      outbound: [],
      data: {},
    };
    const completedStages: PipelineStageName[] = [];
    for (const stage of this.stages) {
      const outcome = await stage.run(context);
      if (outcome.stop) return { context, completedStages, stoppedAt: { stage: stage.name, reason: outcome.reason } };
      completedStages.push(stage.name);
    }
    return { context, completedStages, stoppedAt: null };
  }
}
