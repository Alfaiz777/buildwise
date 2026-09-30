/** Canonical AI enums (docs/04_DATA_MODEL.md §11, §14; docs/05_AI_AGENT_SPEC.md §8). */

export const AI_ACTIONS = [
  'NO_ACTION',
  'EDUCATE',
  'COMPARE',
  'ONLINE_PURCHASE',
  'STORE_DISCOVERY',
  'STORE_RESERVATION',
  'ALTERNATIVE_PRODUCT',
  'HUMAN_HANDOFF',
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/** Which AgentRuntime produced a decision. A MOCK decision is never presented as Gemini. */
export const AGENT_RUNTIMES = ['MOCK', 'ADK_GEMINI'] as const;
export type AgentRuntimeName = (typeof AGENT_RUNTIMES)[number];

export const DECISION_SOURCES = ['AGENT', 'DETERMINISTIC_FALLBACK'] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];

export const GUARDRAIL_STATUSES = ['ALLOWED', 'BLOCKED', 'HUMAN_APPROVAL_REQUIRED'] as const;
export type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number];

export const INTENT_TYPES = [
  'VISIT_ONLY',
  'SEARCH_EXPLORATION',
  'PRODUCT_EXPLORATION',
  'PRODUCT_CONSIDERATION',
  'CART_ABANDONMENT',
  'CHECKOUT_ABANDONMENT',
  'PRODUCT_QUESTION',
  'COMPARISON',
  'URGENT_PURCHASE',
  'STORE_ORIENTED',
  'SUPPORT_REQUEST',
  'UNKNOWN',
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

/** Funnel progress, ordered and monotonic within a web session (docs/04 §11.1, Change 11). */
export const INTENT_STAGES = ['VISIT', 'SEARCH', 'PRODUCT_VIEW', 'CONSIDERATION', 'CART', 'CHECKOUT'] as const;
export type IntentStage = (typeof INTENT_STAGES)[number];

/** How strong the demonstrated intent is: the former three-level stage, now derived. */
export const INTENT_STRENGTHS = ['NO_MEANINGFUL_INTENT', 'INTERESTED', 'HIGH_INTENT'] as const;
export type IntentStrength = (typeof INTENT_STRENGTHS)[number];
