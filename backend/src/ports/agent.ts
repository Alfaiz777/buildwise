/**
 * AgentRuntime port and the AgentDecision contract
 * (docs/06_INTEGRATION_CONTRACTS.md §6, docs/05_AI_AGENT_SPEC.md §8).
 *
 * MockAgentRuntime and AdkGeminiAgentRuntime return exactly this shape and are
 * validated by the same schema. Runtimes call tools only through ToolExecutor
 * and never write to Firestore.
 */
import { z } from 'zod';
import { AGENT_RUNTIMES, AI_ACTIONS, INTENT_TYPES, type AgentRuntimeName } from '../domain/ai.js';
import type { InboundMessage } from './messaging.js';

export const AgentDecisionSchema = z.object({
  runtime: z.enum(AGENT_RUNTIMES),
  intent: z.object({
    intent_type: z.enum(INTENT_TYPES),
    confidence: z.number().min(0).max(1),
  }),
  intervention: z.object({
    should_intervene: z.boolean(),
    reason: z.string(),
  }),
  next_best_action: z.object({
    action: z.enum(AI_ACTIONS),
    store_id: z.string().optional(),
    variant_id: z.string().optional(),
    reason: z.string(),
  }),
  response_strategy: z.object({
    tone: z.string(),
    include_store_context: z.boolean(),
    ask_for_confirmation: z.boolean(),
  }),
  required_tools: z.array(z.string()),
  tool_calls: z.array(
    z.object({
      tool: z.string(),
      status: z.enum(['EXECUTED', 'BLOCKED', 'FAILED']),
      result_reference: z.string().nullable(),
    }),
  ),
  reply: z.object({
    message_type: z.enum(['TEXT', 'INTERACTIVE']),
    text: z.string().min(1),
    options: z.array(z.object({ option_id: z.string(), label: z.string() })).optional(),
  }),
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/** The controlled context package (docs/04_DATA_MODEL.md §20) plus the message being answered. */
export interface DecisionInput {
  brandId: string;
  customerId: string;
  conversationId: string;
  message: InboundMessage;
  /** Minimum-necessary context; shape grows with M5/M7. */
  context: Record<string, unknown>;
  /** Recent turns only, oldest first. */
  history: { direction: 'INBOUND' | 'OUTBOUND'; text: string }[];
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  status: 'EXECUTED' | 'BLOCKED' | 'FAILED';
  /** Verified application data only. */
  output: unknown;
  resultReference: string | null;
  reasonCode: string | null;
}

/** Backend-owned tool execution: authorization, validation and guardrail happen here. */
export interface ToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
}

export interface AgentRuntime {
  readonly runtime: AgentRuntimeName;
  decide(input: DecisionInput, tools: ToolExecutor): Promise<AgentDecision>;
}
