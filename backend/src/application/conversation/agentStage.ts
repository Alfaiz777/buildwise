import {
  AgentDecisionSchema,
  type AgentDecision,
  type AgentRuntime,
  type DecisionInput,
  type ToolExecutor,
} from '../../ports/agent.js';

/** docs/03_TECH_ARCHITECTURE.md §16.1: total AI decision budget per inbound message. */
export const AI_DECISION_BUDGET_MS = 20_000;

export type AgentRunResult =
  | { ok: true; decision: AgentDecision; repaired: boolean }
  | { ok: false; reason: 'TIMEOUT' | 'INVALID_OUTPUT' | 'RUNTIME_ERROR'; repaired: boolean };

class BudgetExceeded extends Error {}

/**
 * Pipeline step 6 core: ask the configured AgentRuntime for a decision within the budget
 * and validate it against the single AgentDecision contract (identical for MOCK and
 * ADK_GEMINI). Invalid output gets ONE repair attempt with the validation error
 * (docs/05 §8); a timeout, a second invalid output or a runtime error returns a failure,
 * and the caller uses the deterministic fallback (docs/03 §16.2). The runtime is chosen by
 * the composition root; this function never knows which one.
 */
export async function runAgentRuntime(
  runtime: AgentRuntime,
  input: DecisionInput,
  tools: ToolExecutor,
  budgetMs: number = AI_DECISION_BUDGET_MS,
): Promise<AgentRunResult> {
  const deadline = Date.now() + budgetMs;
  const withinBudget = <T>(work: Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new BudgetExceeded());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BudgetExceeded()), remaining);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  let repair: DecisionInput['repair'];
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: unknown;
    try {
      raw = await withinBudget(runtime.decide({ ...input, ...(repair ? { repair } : {}) }, tools));
    } catch (err) {
      return { ok: false, reason: err instanceof BudgetExceeded ? 'TIMEOUT' : 'RUNTIME_ERROR', repaired: attempt > 0 };
    }
    const parsed = AgentDecisionSchema.safeParse(raw);
    if (parsed.success && parsed.data.runtime === runtime.runtime) {
      return { ok: true, decision: parsed.data, repaired: attempt > 0 };
    }
    repair = {
      error: parsed.success
        ? `runtime must be ${runtime.runtime}`
        : parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
    };
  }
  return { ok: false, reason: 'INVALID_OUTPUT', repaired: true };
}
