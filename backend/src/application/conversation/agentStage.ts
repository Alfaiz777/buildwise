import {
  AgentDecisionSchema,
  AgentTimeoutError,
  type AgentDecision,
  type AgentRuntime,
  type DecisionInput,
  type ToolExecutor,
} from '../../ports/agent.js';

/**
 * docs/03_TECH_ARCHITECTURE.md §16.1: the AI decision for one inbound message — the configured
 * runtime and, if it fails, the backup — ends within 12 s, counted from the start of the agent
 * stage (a slow context build shortens the model's turn, never the backup's).
 *
 * L5 (measured 2026-10-16, docs/05 §16): Gemini's median turn is 5.1 s; a request that has not
 * answered in 7 s has usually stalled. So Gemini gets at most 9 s (GEMINI_DEADLINE_MS) and the
 * backup the last 2 s.
 */
export const AI_DECISION_BUDGET_MS = 12_000;
/**
 * Time kept inside that budget for the backup runtime (docs/03 §16.2): when the configured
 * runtime fails, the deterministic mock answers the same message with the same tools. It runs
 * in-process; its few Firestore reads take tens of milliseconds, so 2 s is ample.
 */
export const AI_BACKUP_BUDGET_MS = 2_000;

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
      const timedOut = err instanceof BudgetExceeded || err instanceof AgentTimeoutError;
      return { ok: false, reason: timedOut ? 'TIMEOUT' : 'RUNTIME_ERROR', repaired: attempt > 0 };
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
