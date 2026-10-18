import {
  AGENT_PROMPT_VERSION,
  QWIKSPOT_AGENT_PROMPT,
  ModelProposalSchema,
  extractJson,
  modelProposalJsonSchema,
  type ModelProposal,
} from '../../domain/agentPrompt.js';
import { OPTION, DELIVERY_LABEL, parseOption } from '../../domain/agentReplies.js';
import { isWriteTool, type NearbyStoresOutput } from '../../domain/agentTools.js';
import type { IntentType } from '../../domain/ai.js';
import type { Logger } from '../../lib/logger.js';
import { silentLogger } from '../../lib/logger.js';
import {
  AgentTimeoutError,
  type AgentDecision,
  type AgentRuntime,
  type DecisionInput,
  type ToolExecutor,
  type ToolResult,
} from '../../ports/agent.js';
import type { InboundMessage } from '../../ports/messaging.js';
import type { GeminiClient, GeminiResponse, GeminiTurn } from './geminiClient.js';

/**
 * The real Qwikspot AI (docs/05_AI_AGENT_SPEC.md Â§9.2): Gemini on Vertex AI behind the same
 * AgentRuntime port as MockAgentRuntime. It reads the context package, looks things up with
 * the READ tools through the backend ToolExecutor, and returns an AgentDecision. It never
 * writes: a write is proposed in next_best_action / required_tools and executed by the
 * pipeline after the guardrail.
 *
 * Built on the Google Gen AI SDK with a small function-calling loop rather than the ADK
 * package (docs/05 Â§16 says why); the class keeps the name the architecture uses.
 *
 * What the model decides: intent type, action, target ids, the reason and the reply text.
 * What the backend decides here, from what actually happened: the runtime label, tool_calls
 * (the executor's own record) and which write tools the action needs.
 */
export interface GeminiRuntimeOptions {
  client: GeminiClient;
  model: string;
  logger?: Logger;
  /** Tool calls allowed per decision. */
  maxToolCalls?: number;
  /** Time for the whole decide, kept under the pipeline's 25 s budget so the backup runtime still has its 2 s. */
  deadlineMs?: number;
  /** Time for one model request. */
  requestTimeoutMs?: number;
  /** A retry starts only if at least this much of the deadline is left. */
  minAttemptMs?: number;
  /** Tests only: GEMINI_HEDGE_AFTER_MS. */
  hedgeAfterMs?: number;
  temperature?: number;
}

export const GEMINI_MAX_TOOL_CALLS = 5;
/**
 * Measured on the global endpoint (docs/05 §16): a request usually takes 2–7 s and about one
 * in ten stalls for 10–30 s; a whole Gemini turn has a median of 5.1 s (2026-10-16).
 * Gemini-first (2026-10-18): the shopper's answers should come from Gemini, not the backup, so
 * a whole decision may take up to 22 s. The WhatsApp webhook is acknowledged before the
 * pipeline runs, so a slower reply never makes Meta retry. A request still unanswered at
 * 4.5 s is hedged (sent once more, the first answer wins), each request is cut off at 10 s and
 * retried while the deadline allows a real attempt, and only after 22 s does the backup
 * runtime (the mock) answer in its 2 s, inside the pipeline's 25 s ceiling
 * (AI_DECISION_BUDGET_MS).
 *
 * A failed request (a timeout, 429, 5xx) is tried once more only while the deadline still
 * leaves GEMINI_MIN_ATTEMPT_MS for it: a model request has never answered faster than about
 * 2.5 s, so a retry with less time could only time out again — the backup answers sooner.
 */
export const GEMINI_DEADLINE_MS = 22_000;
export const GEMINI_REQUEST_TIMEOUT_MS = 10_000;
export const GEMINI_REQUEST_ATTEMPTS = 2;
export const GEMINI_MIN_ATTEMPT_MS = 2_500;
export const GEMINI_TEMPERATURE = 0.2;
/**
 * L9: a request still unanswered after this long is sent once more and the first answer wins
 * (the other is cancelled) â€” a stalled request no longer costs the whole decision. Only while
 * the deadline still leaves GEMINI_MIN_ATTEMPT_MS for the second one.
 */
export const GEMINI_HEDGE_AFTER_MS = 4_500;

/** Intent types the conversation may refine a bound intent to (the type only, never the stage). */
const REFINABLE: readonly IntentType[] = ['PRODUCT_QUESTION', 'COMPARISON', 'URGENT_PURCHASE'];
/** Intent types a store search may start a conversation intent with. */
const STARTABLE: readonly IntentType[] = ['URGENT_PURCHASE', 'STORE_ORIENTED'];

const QUICK_REPLY_LABEL: Record<string, string> = {
  [OPTION.buyOnline]: DELIVERY_LABEL,
  [OPTION.otherStores]: 'Other stores',
  [OPTION.handoff]: 'Talk to a person',
};

export class GeminiOutputError extends Error {}

export class AdkGeminiAgentRuntime implements AgentRuntime {
  readonly runtime = 'ADK_GEMINI' as const;
  private readonly logger: Logger;
  /**
   * Why the model's answer for a message was rejected, kept for the pipeline's single repair
   * attempt (which passes the same message object again). Weak: it lives as long as the message.
   */
  private readonly rejected = new WeakMap<InboundMessage, string>();

  constructor(private readonly options: GeminiRuntimeOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async decide(input: DecisionInput, tools: ToolExecutor): Promise<AgentDecision> {
    const started = performance.now();
    const deadline = started + (this.options.deadlineMs ?? GEMINI_DEADLINE_MS);
    const maxCalls = this.options.maxToolCalls ?? GEMINI_MAX_TOOL_CALLS;
    // Defence in depth: whatever the pipeline declares, the model is offered read tools only.
    const readTools = input.tools.filter((t) => !isWriteTool(t.name));
    const allowed = new Set(readTools.map((t) => t.name));

    const repairError = input.repair ? (this.rejected.get(input.message) ?? input.repair.error) : null;
    const turns: GeminiTurn[] = [{ role: 'user', text: JSON.stringify(modelInput(input, repairError)) }];
    const calls: ToolResult[] = [];
    const usage = { promptTokens: 0, outputTokens: 0 };
    let requests = 0;
    let retries = 0;
    const hedges = { count: 0 };
    let outcome = 'ERROR';

    try {
      for (;;) {
        const offerTools = calls.length < maxCalls;
        const response = await this.request(
          {
            model: this.options.model,
            system: QWIKSPOT_AGENT_PROMPT,
            turns,
            tools: offerTools ? readTools : [],
            responseSchema: modelProposalJsonSchema(),
            temperature: this.options.temperature ?? GEMINI_TEMPERATURE,
          },
          deadline,
          () => (retries += 1),
          hedges,
        );
        requests += 1;
        usage.promptTokens += response.usage.promptTokens;
        usage.outputTokens += response.usage.outputTokens;

        if (offerTools && response.functionCalls.length > 0) {
          const results: Extract<GeminiTurn, { role: 'tool' }>['results'] = [];
          for (const call of response.functionCalls) {
            const base = { ...(call.id ? { id: call.id } : {}), name: call.name };
            if (calls.length >= maxCalls) {
              results.push({ ...base, response: { error: 'TOOL_CALL_LIMIT_REACHED' } });
            } else if (!allowed.has(call.name)) {
              // Not a tool this runtime offers (a write tool, or an invented name): never executed.
              results.push({ ...base, response: { error: 'TOOL_NOT_AVAILABLE' } });
            } else {
              const result = await tools.execute({ tool: call.name, input: call.args });
              calls.push(result);
              results.push({
                ...base,
                response:
                  result.status === 'EXECUTED'
                    ? { result: result.output }
                    : { error: result.reasonCode ?? result.status },
              });
            }
          }
          turns.push({ role: 'model', raw: response.raw }, { role: 'tool', results });
          continue;
        }

        const proposal = parseProposal(response.text);
        const decision = toDecision(proposal, input, calls);
        outcome = decision.next_best_action.action;
        return decision;
      }
    } catch (err) {
      if (err instanceof GeminiOutputError) {
        // Not a decision: returned as is so the pipeline's contract check rejects it and makes
        // its one repair attempt, then the deterministic fallback (docs/05 Â§8).
        outcome = 'INVALID_OUTPUT';
        this.rejected.set(input.message, err.message);
        return { runtime: this.runtime, invalid_output: true } as unknown as AgentDecision;
      }
      throw err;
    } finally {
      // IDs, names and counts only: never message text, replies or customer references.
      this.logger.info('agent.gemini_decision', {
        runtime: this.runtime,
        model: this.options.model,
        prompt_version: AGENT_PROMPT_VERSION,
        latency_ms: Math.round(performance.now() - started),
        requests,
        retries,
        hedges: hedges.count,
        tools: calls.map((c) => c.tool),
        prompt_tokens: usage.promptTokens,
        output_tokens: usage.outputTokens,
        action: outcome,
        repair: Boolean(input.repair),
      });
    }
  }

  /**
   * One model request, cancelled at its own timeout or at the decision deadline, whichever is
   * first. A timeout or a transient Vertex error (429, 5xx, network) is tried once more while
   * the deadline allows; anything else is thrown to the pipeline (â†’ deterministic fallback).
   */
  private async request(
    request: Parameters<GeminiClient['generate']>[0],
    deadline: number,
    onRetry: () => void,
    hedges: { count: number } = { count: 0 },
  ): Promise<GeminiResponse> {
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new AgentTimeoutError('GEMINI_DEADLINE_EXCEEDED');
      const controller = new AbortController();
      const limit = Math.min(remaining, this.options.requestTimeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS);
      let timer: NodeJS.Timeout | undefined;
      let expire: () => void = () => undefined;
      const timeout = new Promise<never>((_, reject) => {
        expire = () => {
          // Reject first: the abort makes the request itself fail, and that must not win the race.
          reject(new GeminiTimeout());
          controller.abort();
        };
        timer = setTimeout(expire, limit);
      });
      // A hedged request gets the rest of the deadline, not the rest of the first one's limit.
      const onHedge = () => {
        clearTimeout(timer);
        timer = setTimeout(expire, Math.max(0, deadline - performance.now()));
      };
      try {
        return await Promise.race([
          hedgedSend(
            this.options.client,
            request,
            controller,
            deadline,
            this.options.hedgeAfterMs ?? GEMINI_HEDGE_AFTER_MS,
            this.options.minAttemptMs ?? GEMINI_MIN_ATTEMPT_MS,
            hedges,
            onHedge,
          ),
          timeout,
        ]);
      } catch (err) {
        if (attempt >= GEMINI_REQUEST_ATTEMPTS || !isTransient(err)) throw err;
        // No time left for a real second attempt: give up now, so the backup answers sooner.
        if (deadline - performance.now() < (this.options.minAttemptMs ?? GEMINI_MIN_ATTEMPT_MS)) throw err;
        onRetry();
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * One request, hedged (L9): if it has not answered after GEMINI_HEDGE_AFTER_MS and the deadline
 * still leaves a second attempt its time, the same request is sent again; the first answer wins
 * and the other is cancelled. Fails only when every request sent has failed.
 */
function hedgedSend(
  client: GeminiClient,
  request: Parameters<GeminiClient['generate']>[0],
  controller: AbortController,
  deadline: number,
  hedgeAfterMs: number,
  minAttemptMs: number,
  hedges: { count: number },
  onHedge: () => void = () => undefined,
): Promise<GeminiResponse> {
  return new Promise((resolve, reject) => {
    const second = new AbortController();
    controller.signal.addEventListener('abort', () => second.abort(), { once: true });
    let pending = 1;
    let done = false;
    const win = (r: GeminiResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Cancel the slower one (harmless for the one that answered, or a second never sent).
      controller.abort();
      second.abort();
      resolve(r);
    };
    const lose = (err: unknown) => {
      if (done || --pending > 0) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    };
    client.generate(request, controller.signal).then(win, lose);
    const timer = setTimeout(() => {
      if (done || controller.signal.aborted || deadline - performance.now() < minAttemptMs) return;
      hedges.count += 1;
      pending += 1;
      onHedge();
      client.generate(request, second.signal).then(win, lose);
    }, hedgeAfterMs);
  });
}

class GeminiTimeout extends AgentTimeoutError {}

/** Worth one more try: our own timeout, rate limiting, a server error, or no HTTP status at all. */
function isTransient(err: unknown): boolean {
  if (err instanceof GeminiTimeout) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status === 429 || status >= 500;
}

/** The user turn: the context package and the inbound message, as JSON. No phone number, no token. */
export function modelInput(input: DecisionInput, repairError: string | null = null): Record<string, unknown> {
  const content = input.message.content;
  const message =
    content.type === 'TEXT'
      ? { type: 'TEXT', text: input.text ?? '' }
      : content.type === 'INTERACTIVE_REPLY'
        ? { type: 'OPTION', option_id: content.optionId }
        : { type: 'LOCATION', note: 'The customer shared a location. It is saved; search stores without an area.' };
  return {
    context: input.context,
    message,
    ...(repairError
      ? {
          repair: {
            error: repairError,
            instruction: 'Your previous answer was rejected. Return corrected JSON that fixes this error.',
          },
        }
      : {}),
  };
}

function parseProposal(text: string | null): ModelProposal {
  if (!text?.trim()) throw new GeminiOutputError('The model returned no answer.');
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    throw new GeminiOutputError('The model answer is not JSON.');
  }
  const parsed = ModelProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GeminiOutputError(
      parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** The last successful find_nearby_stores of this run â€” for `variantId` when given and searched. */
function lastStoreSearch(calls: ToolResult[], variantId: string | undefined): NearbyStoresOutput | null {
  const finds = calls
    .filter((c) => c.tool === 'find_nearby_stores' && c.status === 'EXECUTED' && c.output)
    .map((c) => c.output as NearbyStoresOutput);
  return finds.findLast((f) => f.variant?.variant_id === variantId) ?? finds.at(-1) ?? null;
}

/** Ids the model may point at: only ones the backend showed it in this turn. */
function knownIds(input: DecisionInput, calls: ToolResult[]) {
  const variants = new Set<string>();
  const stores = new Set<string>();
  const reservations = new Set<string>();
  const ctx = input.context;
  for (const entry of ctx.catalog) for (const v of entry.variants) variants.add(v.variant_id);
  for (const sheet of ctx.products) for (const v of sheet.variants) variants.add(v.variant_id);
  if (ctx.intent?.variant_id) variants.add(ctx.intent.variant_id);
  if (ctx.pending_proposal) {
    variants.add(ctx.pending_proposal.variant_id);
    stores.add(ctx.pending_proposal.store_id);
    for (const id of ctx.pending_proposal.offered_stores) stores.add(id);
  }
  const content = input.message.content;
  if (content.type === 'INTERACTIVE_REPLY') {
    const [kind, id] = content.optionId.split(/:(.*)/s);
    if (id && kind === 'hold') stores.add(id);
    if (id && kind === 'cancel') reservations.add(id);
    if (id && kind === 'recheck') variants.add(id);
  }
  for (const call of calls) {
    if (call.status !== 'EXECUTED' || !call.output || typeof call.output !== 'object') continue;
    const out = call.output as Record<string, unknown>;
    if (call.tool === 'find_nearby_stores') {
      const find = out as unknown as NearbyStoresOutput;
      if (find.variant) variants.add(find.variant.variant_id);
      for (const s of find.eligible ?? []) stores.add(s.store_id);
    }
    if (call.tool === 'get_product_context') {
      const sheets = [out.product, ...((out.alternatives as unknown[]) ?? [])] as ({
        variants?: { variant_id: string }[];
      } | null)[];
      for (const sheet of sheets) for (const v of sheet?.variants ?? []) variants.add(v.variant_id);
      if (typeof out.variant_id === 'string') variants.add(out.variant_id);
    }
    if (call.tool === 'get_customer_history') {
      for (const r of (out.active_reservations as { reservation_id: string; variant_id: string }[]) ?? []) {
        reservations.add(r.reservation_id);
        variants.add(r.variant_id);
      }
    }
  }
  return { variants, stores, reservations };
}

/**
 * The model's proposal â†’ the AgentDecision contract. Ids the backend never showed the model
 * are dropped (an invented store or reservation cannot reach the guardrail as a target), and
 * the write tools follow from the action â€” the model never names one.
 */
export function toDecision(proposal: ModelProposal, input: DecisionInput, calls: ToolResult[]): AgentDecision {
  const ctx = input.context;
  const known = knownIds(input, calls);
  let variantId = proposal.variant_id && known.variants.has(proposal.variant_id) ? proposal.variant_id : undefined;
  let storeId = proposal.store_id && known.stores.has(proposal.store_id) ? proposal.store_id : undefined;
  if (proposal.action === 'STORE_DISCOVERY') {
    // A store search is reported from the search itself: the variant that was searched and its
    // nearest eligible store, so the verified store card is built even when the model left an id out.
    const find = lastStoreSearch(calls, variantId);
    if (find?.variant) {
      variantId = find.variant.variant_id;
      const eligible = find.eligible.map((s) => s.store_id);
      storeId = storeId && eligible.includes(storeId) ? storeId : eligible[0];
    }
  }
  const cancelId =
    proposal.cancel_reservation_id && known.reservations.has(proposal.cancel_reservation_id)
      ? proposal.cancel_reservation_id
      : undefined;
  if (proposal.action === 'STORE_RESERVATION' && ctx.pending_proposal) {
    // Confirming the offer on the table: the store is the one the customer tapped (else the
    // offered one) and the variant is the offered one â€” taken from the tap and the pending
    // proposal, not from the model. The guardrail still re-checks everything against fresh data.
    const content = input.message.content;
    const tapped = content.type === 'INTERACTIVE_REPLY' ? parseOption(content.optionId) : null;
    storeId = (tapped?.kind === 'HOLD' ? tapped.storeId : storeId) ?? ctx.pending_proposal.store_id;
    variantId = ctx.pending_proposal.variant_id;
  }
  let action = proposal.action;
  // A person was asked for but the brand has handoff switched off: nothing to execute.
  if (action === 'HUMAN_HANDOFF' && !ctx.brand.handoff_enabled) action = 'NO_ACTION';

  const required: string[] = [];
  if (action === 'STORE_RESERVATION') required.push('create_reservation');
  if (action === 'HUMAN_HANDOFF') required.push('request_human_handoff');
  if (action === 'NO_ACTION' && cancelId) required.push('cancel_reservation');
  const searched = ['STORE_DISCOVERY', 'ONLINE_PURCHASE', 'ALTERNATIVE_PRODUCT'].includes(action);
  if (ctx.intent) {
    // Refine the bound intent's type (never its stage).
    if (REFINABLE.includes(proposal.intent_type) && ctx.intent.intent_type !== proposal.intent_type) {
      required.push('record_customer_intent');
    }
  } else if (searched && variantId && STARTABLE.includes(proposal.intent_type)) {
    // A customer who wrote in directly: the product they asked a store for stays bound.
    required.push('record_customer_intent');
  }

  const commerce = searched || action === 'STORE_RESERVATION' || Boolean(cancelId);
  const turnType = action === 'NO_ACTION' && !cancelId ? (proposal.turn_type ?? undefined) : undefined;
  const options = commerce
    ? []
    : [...new Set(proposal.quick_replies ?? [])]
        .filter((id) => id !== OPTION.handoff || ctx.brand.handoff_enabled)
        .map((id) => ({ option_id: id, label: QUICK_REPLY_LABEL[id]! }));

  return {
    runtime: 'ADK_GEMINI',
    intent: { intent_type: proposal.intent_type, confidence: proposal.confidence },
    intervention: { should_intervene: action !== 'NO_ACTION' || Boolean(cancelId), reason: proposal.reason },
    next_best_action: {
      action,
      ...(storeId ? { store_id: storeId } : {}),
      ...(variantId ? { variant_id: variantId } : {}),
      ...(action === 'STORE_RESERVATION' ? { quantity: proposal.quantity ?? ctx.pending_proposal?.quantity ?? 1 } : {}),
      ...(cancelId ? { reservation_id: cancelId } : {}),
      ...(turnType ? { turn_type: turnType } : {}),
      reason: proposal.reason,
    },
    response_strategy: {
      tone: 'friendly',
      include_store_context: action === 'STORE_DISCOVERY' || action === 'STORE_RESERVATION',
      ask_for_confirmation: action === 'STORE_DISCOVERY' && Boolean(storeId),
    },
    required_tools: required,
    tool_calls: calls.map((c) => ({ tool: c.tool, status: c.status, result_reference: c.resultReference })),
    reply: {
      message_type: options.length ? 'INTERACTIVE' : 'TEXT',
      text: proposal.reply_text.trim(),
      ...(options.length ? { options } : {}),
    },
  };
}
