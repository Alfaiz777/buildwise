import type { DecisionSource, GuardrailStatus } from '../../domain/ai.js';
import type { AgentDecision } from '../../ports/agent.js';
import type { InboundMessage, OutboundMessage } from '../../ports/messaging.js';

/**
 * The ONE conversation pipeline for every customer channel
 * (docs/03_TECH_ARCHITECTURE.md §8.2):
 *
 *   WhatsApp webhook ─┐
 *                     ├─► ConversationPipeline.handleInbound(InboundMessage)
 *   Simulator channel ┘
 *
 * The stage order is fixed here and cannot be changed by wiring. M2 provides the
 * structure; the stages are implemented in M6 (1–5, 9–10), M7 (6–8) and M10 (11).
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
