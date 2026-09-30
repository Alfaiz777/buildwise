/**
 * The deterministic fallback decision (docs/03_TECH_ARCHITECTURE.md §16.2), used only when
 * the agent runtime fails: the budget elapsed, the output was still invalid after one
 * repair attempt, or the runtime threw. It sends a fixed, safe holding reply, never claims
 * stock, price or policy, and never executes a commerce action. With human handoff enabled
 * it is recorded as HUMAN_HANDOFF (a person takes over); otherwise NO_ACTION with a
 * "please try again" reply. The failed runtime's name is kept.
 */
import type { AgentRuntimeName, IntentType } from './ai.js';
import { fallbackRetryText } from './agentReplies.js';

export interface FallbackInput {
  runtime: AgentRuntimeName;
  handoffEnabled: boolean;
  brandName: string;
  intentType: IntentType | null;
  failure: string;
}

/** Same shape as the AgentDecision contract (validated by AgentDecisionSchema). */
export function buildFallbackDecision(input: FallbackInput) {
  const handoff = input.handoffEnabled;
  return {
    runtime: input.runtime,
    intent: { intent_type: input.intentType ?? ('UNKNOWN' as const), confidence: 0.1 },
    intervention: {
      should_intervene: handoff,
      reason: `Agent runtime failed (${input.failure}): deterministic fallback.`,
    },
    next_best_action: {
      action: handoff ? ('HUMAN_HANDOFF' as const) : ('NO_ACTION' as const),
      reason: handoff
        ? 'Fallback: a person takes over while automated help is unavailable.'
        : 'Fallback: no action; the customer is asked to try again.',
    },
    response_strategy: { tone: 'friendly', include_store_context: false, ask_for_confirmation: false },
    required_tools: handoff ? ['request_human_handoff'] : ([] as string[]),
    tool_calls: [] as { tool: string; status: 'EXECUTED' | 'BLOCKED' | 'FAILED'; result_reference: string | null }[],
    reply: {
      message_type: 'TEXT' as const,
      text: handoff
        ? `Thanks for your message. A member of the ${input.brandName} team will reply here shortly.`
        : fallbackRetryText,
    },
  };
}
