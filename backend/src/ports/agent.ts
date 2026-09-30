/**
 * AgentRuntime port and the AgentDecision contract
 * (docs/06_INTEGRATION_CONTRACTS.md §6, docs/05_AI_AGENT_SPEC.md §8).
 *
 * MockAgentRuntime and AdkGeminiAgentRuntime return exactly this shape and are
 * validated by the same schema. Runtimes call tools only through ToolExecutor
 * and never write to Firestore.
 */
import { z } from 'zod';
import {
  AGENT_RUNTIMES,
  AI_ACTIONS,
  INTENT_TYPES,
  type AgentRuntimeName,
  type IntentStage,
  type IntentStrength,
  type IntentType,
} from '../domain/ai.js';
import type { ProductSheet } from '../domain/agentTools.js';
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
    /** M5: units to hold (default 1) and the reservation a cancel refers to. */
    quantity: z.number().int().min(1).max(100).optional(),
    reservation_id: z.string().optional(),
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

export interface PendingProposalView {
  store_id: string;
  variant_id: string;
  quantity: number;
  proposed_at: string;
  expires_at: string;
  offered_stores: string[];
}

/** The controlled context package (docs/04_DATA_MODEL.md §20). Built by the backend only. */
export interface AgentContext {
  brand: {
    display_name: string;
    policy_summary: string;
    reservation_policy: { reservations_enabled: boolean; hold_minutes: number; max_quantity_per_reservation: number };
    handoff_enabled: boolean;
    online_purchase_available: boolean;
  };
  customer: {
    channel: string;
    customer_ref: string;
    consent_state: string;
    last_location: {
      latitude: number;
      longitude: number;
      source: 'SHARED' | 'LOCALITY';
      locality: string | null;
      at: string;
    } | null;
  };
  intent: {
    intent_id: string;
    intent_type: IntentType;
    intent_stage: IntentStage;
    intent_strength: IntentStrength;
    product_id: string | null;
    variant_id: string | null;
    follow_up: { status: string; template_name: string | null } | null;
  } | null;
  /** The bound product and its verified alternatives. */
  products: ProductSheet[];
  /** Last 10 messages, oldest first, intent token already removed. */
  history: { direction: 'INBOUND' | 'OUTBOUND'; text: string }[];
  pending_proposal: PendingProposalView | null;
}

/** The context package plus the inbound message being answered (docs/06 §6). */
export interface DecisionInput {
  brandId: string;
  customerId: string;
  conversationId: string;
  message: InboundMessage;
  /** The inbound text with any intent token removed (null for non-text messages). */
  text: string | null;
  context: AgentContext;
  /** Recent turns only, oldest first (same as context.history). */
  history: { direction: 'INBOUND' | 'OUTBOUND'; text: string }[];
  /** Set on the single repair attempt after invalid output (docs/05 §8). */
  repair?: { error: string };
  /** JSON Schema declarations of the tools this runtime may call during decide. */
  tools: { name: string; description: string; parameters: unknown }[];
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
