import type { AgentDecision, AgentRuntime, DecisionInput, ToolExecutor } from '../../ports/agent.js';

/**
 * Deterministic stand-in for AdkGeminiAgentRuntime (docs/05_AI_AGENT_SPEC.md §9.2).
 * For pipeline tests, contract tests and local development ONLY. Every decision
 * is tagged runtime = MOCK and must never be presented as Gemini.
 *
 * M2 establishes the contract with one rule (explicit human request → handoff).
 * The documented rule set and tool use arrive in M5.
 */
const HUMAN_REQUEST = /\b(human|person|agent|someone|representative)\b/i;

export class MockAgentRuntime implements AgentRuntime {
  readonly runtime = 'MOCK' as const;

  async decide(input: DecisionInput, _tools: ToolExecutor): Promise<AgentDecision> {
    const text = input.message.content.type === 'TEXT' ? input.message.content.text : '';
    const wantsHuman = HUMAN_REQUEST.test(text);

    return {
      runtime: 'MOCK',
      intent: { intent_type: wantsHuman ? 'SUPPORT_REQUEST' : 'UNKNOWN', confidence: wantsHuman ? 0.9 : 0.2 },
      intervention: {
        should_intervene: wantsHuman,
        reason: wantsHuman ? 'Customer asked for a person.' : 'No rule matched (mock runtime).',
      },
      next_best_action: {
        action: wantsHuman ? 'HUMAN_HANDOFF' : 'NO_ACTION',
        reason: wantsHuman ? 'Explicit request for a human.' : 'Mock runtime: no matching rule.',
      },
      response_strategy: { tone: 'friendly', include_store_context: false, ask_for_confirmation: false },
      required_tools: [],
      tool_calls: [],
      reply: {
        message_type: 'TEXT',
        text: wantsHuman
          ? 'I will connect you with a member of our team.'
          : 'Thanks for your message. How can I help you today?',
      },
    };
  }
}
