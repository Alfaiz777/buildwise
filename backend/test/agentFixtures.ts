/** Small builders for agent-runtime unit tests. */
import type { AgentContext, DecisionInput } from '../src/ports/agent.js';
import { AgentToolExecutor, type ToolHandlers, type ToolScope } from '../src/application/agent/toolExecutor.js';

export function emptyContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    brand: {
      display_name: 'Demo Co',
      policy_summary: '',
      reservation_policy: { reservations_enabled: true, hold_minutes: 120, max_quantity_per_reservation: 2 },
      handoff_enabled: true,
      online_purchase_available: false,
    },
    customer: { channel: 'SIMULATOR', customer_ref: 'sim:c', consent_state: 'UNKNOWN', last_location: null },
    intent: null,
    products: [],
    history: [],
    pending_proposal: null,
    ...overrides,
  };
}

export function decisionInput(
  content: DecisionInput['message']['content'],
  context: AgentContext = emptyContext(),
): DecisionInput {
  return {
    brandId: 'b',
    customerId: 'c',
    conversationId: 'conv',
    message: {
      channel: 'SIMULATOR',
      brandId: 'b',
      externalCustomerRef: 'sim:c',
      externalMessageId: 'm1',
      receivedAt: new Date().toISOString(),
      content,
    },
    text: content.type === 'TEXT' ? content.text : null,
    context,
    history: context.history,
    tools: [],
  };
}

export const SCOPE: ToolScope = {
  brandId: 'b',
  customerId: 'c',
  conversationId: 'conv',
  intentId: null,
  recommendationId: 'rec_1',
};

/** An executor whose handlers return fixed outputs (unknown handlers throw → FAILED). */
export function stubExecutor(
  outputs: Partial<Record<string, unknown>> = {},
  onBlocked?: (t: string, r: string) => Promise<void>,
) {
  const handlers = new Proxy(
    {},
    {
      get: (_t, name: string) => async () => {
        if (!(name in outputs)) throw new Error(`no stub for ${name}`);
        return { status: 'EXECUTED', output: outputs[name] };
      },
    },
  ) as ToolHandlers;
  return new AgentToolExecutor(handlers, SCOPE, onBlocked);
}
