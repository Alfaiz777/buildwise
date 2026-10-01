/**
 * Agent tool declarations (docs/05_AI_AGENT_SPEC.md §6, docs/06 §6): the same list is
 * given to MockAgentRuntime now and to AdkGeminiAgentRuntime later (as JSON Schema).
 * Inputs are strict: unknown keys are invalid, and scope keys (brand / customer /
 * conversation) are rejected before validation — scope always comes from the pipeline.
 */
import { z } from 'zod';
import { INTENT_TYPES } from '../domain/ai.js';
import type { ToolName } from '../domain/agentTools.js';

const id = z.string().min(1).max(128);

export const TOOL_INPUTS = {
  get_product_context: z
    .object({ product_id: id.optional(), variant_id: id.optional(), query: z.string().min(1).max(200).optional() })
    .strict(),
  get_brand_policy: z.object({}).strict(),
  get_customer_history: z.object({}).strict(),
  find_nearby_stores: z
    .object({
      variant_id: id,
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      area: z.string().min(1).max(200).optional(),
      radius_km: z.number().positive().max(25).optional(),
      skip_stores: z.array(id).max(20).optional(),
    })
    .strict(),
  check_store_inventory: z.object({ store_id: id, variant_id: id }).strict(),
  get_store_hours: z.object({ store_id: id }).strict(),
  create_reservation: z
    .object({
      store_id: id,
      variant_id: id,
      quantity: z.number().int().min(1).max(100),
      customer_eta: z.iso.datetime().optional(),
    })
    .strict(),
  cancel_reservation: z.object({ reservation_id: id }).strict(),
  request_human_handoff: z.object({ reason: z.string().min(1).max(200) }).strict(),
  record_customer_intent: z.object({ intent_type: z.enum(INTENT_TYPES) }).strict(),
} satisfies Record<ToolName, z.ZodType>;

export type ToolInput<T extends ToolName> = z.infer<(typeof TOOL_INPUTS)[T]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_product_context:
    'Verified catalogue data (title, variants, prices, tags, attributes) for a product or variant, or a unique match for a free-text query, plus verified alternatives.',
  get_brand_policy: "The brand's reservation, handoff and payment policy.",
  get_customer_history: "The current customer's own reservations (never another customer's).",
  find_nearby_stores:
    "Stores for a variant near the customer, nearest first: eligible stores (active, open now, in stock, accepting reservations) and every excluded store with its reason. Uses the given coordinates, else an area name that matches a store locality (approximate), else the customer's last shared location.",
  check_store_inventory: 'Verified available quantity of a variant at one store.',
  get_store_hours: "A store's hours today and whether it is open now, in the store's timezone.",
  create_reservation:
    'Holds units of a variant at a store for the current customer. Executed by the backend only after the guardrail approves it.',
  cancel_reservation: "Cancels one of the current customer's own active reservations.",
  request_human_handoff: 'Stops automated replies and routes the conversation to a person.',
  record_customer_intent: "Refines the bound intent's intent_type (never its stage).",
};

/** JSON Schema tool declarations for a runtime (docs/06 §6). */
export function toolDeclarations(names: readonly ToolName[]) {
  return names.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    parameters: z.toJSONSchema(TOOL_INPUTS[name]),
  }));
}

/** Keys an agent may never pass: scope is injected by the pipeline. */
export const SCOPE_KEYS = ['brand_id', 'brandId', 'customer_id', 'customerId', 'conversation_id', 'conversationId'];
