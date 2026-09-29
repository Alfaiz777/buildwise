import { AgentDecisionSchema, type AgentRuntime, type ToolExecutor } from '../../ports/agent.js';
import { CONTINUE, type PipelineStage } from './pipeline.js';

/**
 * Pipeline stage 6: ask the configured AgentRuntime for a decision and validate
 * it against the single AgentDecision contract — identical for MOCK and ADK_GEMINI.
 * The runtime is chosen by the composition root; this stage never knows which one.
 * Timeout budget, repair attempt and deterministic fallback arrive in M5.
 */
export function createAgentStage(runtime: AgentRuntime, tools: ToolExecutor): PipelineStage {
  return {
    name: 'AGENT',
    async run(context) {
      if (!context.customerId || !context.conversationId) {
        throw new Error('AGENT stage requires IDENTITY and CONVERSATION_STATE to have run');
      }
      const decision = AgentDecisionSchema.parse(
        await runtime.decide(
          {
            brandId: context.inbound.brandId,
            customerId: context.customerId,
            conversationId: context.conversationId,
            message: context.inbound,
            context: {},
            history: [],
          },
          tools,
        ),
      );
      if (decision.runtime !== runtime.runtime) {
        throw new Error('AgentDecision.runtime does not match the runtime that produced it');
      }
      context.decision = decision;
      context.decisionSource = 'AGENT';
      return CONTINUE;
    },
  };
}
