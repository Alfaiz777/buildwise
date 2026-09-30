/**
 * The deterministic fallback decision (docs/03_TECH_ARCHITECTURE.md §16.2). In M4 the
 * agent stage is not built, so every automated reply is this fixed, safe reply: it never
 * claims stock, price or policy, and it never executes a commerce action. It may name the
 * bound intent's verified product title so the reply stays on topic.
 */
import type { AgentRuntimeName, IntentType } from './ai.js';

export interface FallbackInput {
  runtime: AgentRuntimeName;
  wantsHuman: boolean;
  handoffEnabled: boolean;
  brandName: string;
  /** Verified data from the bound intent, when there is one. */
  intent: { type: IntentType; productTitle: string | null } | null;
}

/** Same shape as the AgentDecision contract (validated by AgentDecisionSchema). */
export function buildFallbackDecision(input: FallbackInput) {
  const handoff = input.wantsHuman && input.handoffEnabled;
  const product = input.intent?.productTitle ?? null;

  const text = handoff
    ? `Thanks. I've asked a member of the ${input.brandName} team to take over this conversation. They will reply here.`
    : topicalReply(input.intent?.type ?? null, product);

  return {
    runtime: input.runtime,
    intent: {
      intent_type: handoff ? ('SUPPORT_REQUEST' as const) : (input.intent?.type ?? ('UNKNOWN' as const)),
      confidence: handoff ? 0.9 : input.intent ? 0.5 : 0.1,
    },
    intervention: {
      should_intervene: handoff,
      reason: handoff ? 'The customer asked for a person.' : 'Deterministic fallback reply (M4: no agent runtime).',
    },
    next_best_action: {
      action: handoff ? ('HUMAN_HANDOFF' as const) : ('NO_ACTION' as const),
      reason: handoff ? 'Explicit request for a person; human handoff is enabled.' : 'Fallback: no action proposed.',
    },
    response_strategy: { tone: 'friendly', include_store_context: false, ask_for_confirmation: false },
    required_tools: [] as string[],
    tool_calls: [] as { tool: string; status: 'EXECUTED' | 'BLOCKED' | 'FAILED'; result_reference: string | null }[],
    reply: { message_type: 'TEXT' as const, text },
  };
}

function topicalReply(type: IntentType | null, product: string | null): string {
  if (!product) return 'Thanks for your message. Tell me what you are looking for and I will help.';
  switch (type) {
    case 'CART_ABANDONMENT':
    case 'CHECKOUT_ABANDONMENT':
      return `Thanks for replying. Happy to help with ${product} — what would you like to know before you complete your order?`;
    case 'STORE_ORIENTED':
      return `Thanks. To help you find ${product} nearby, tell me your area.`;
    default:
      return `Thanks for your message about ${product}. What would you like to know?`;
  }
}
