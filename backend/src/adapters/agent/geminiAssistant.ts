/**
 * "Ask Qwikspot" on Gemini (docs/05 §18), for every console's agent: one request with the whole
 * data pack, at most two rounds of the caller's read-only tools, then a structured JSON answer.
 * Cancelled by the caller's signal (its deadline). It never writes anything.
 */
import { extractJson } from '../../domain/agentPrompt.js';
import type { Logger } from '../../lib/logger.js';
import { silentLogger } from '../../lib/logger.js';
import type { AssistantModel, AssistantModelResult, AssistantRequest, AssistantTrace } from '../../ports/assistant.js';
import type { GeminiClient, GeminiResponse, GeminiTurn } from './geminiClient.js';

export const ASSISTANT_MAX_TOOL_ROUNDS = 2;
/**
 * Time kept for the final (answer) round: no more tool rounds once less than this is left
 * before the caller's deadline. Live answer rounds take 2–7 s (L8 eval).
 */
export const FINAL_ROUND_RESERVE_MS = 8_000;

/** Wait before the one retry of a 429 (Vertex "Resource exhausted"). */
export const RATE_LIMIT_RETRY_DELAY_MS = 500;

/**
 * A round still unanswered after this long is sent once more and the first reply wins: Vertex
 * sometimes never answers a request (0 rounds in 17 s, L8 eval); live rounds: p50 2.8 s, p90 4.9 s.
 */
export const HEDGE_AFTER_MS = 7_000;
/** A second request is sent only if it can still answer: at least this long before the deadline. */
export const HEDGE_MIN_LEFT_MS = 6_000;

export class AssistantAnswerError extends Error {}

/** A controller that is aborted with `parent` (and can be aborted on its own). */
const childOf = (parent: AbortSignal) => {
  const c = new AbortController();
  if (parent.aborted) c.abort();
  else parent.addEventListener('abort', () => c.abort(), { once: true });
  return c;
};

const isRateLimited = (err: unknown) => (err as { status?: unknown }).status === 429;
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class GeminiAssistant implements AssistantModel {
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      client: GeminiClient;
      model: string;
      logger?: Logger;
      temperature?: number;
      /** Tests only: HEDGE_AFTER_MS. */
      hedgeAfterMs?: number;
    },
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  get model() {
    return this.options.model;
  }

  /**
   * One round's request, hedged: if it has not answered after HEDGE_AFTER_MS and a second one can
   * still finish before `finishBy`, the same request is sent again; the first answer wins and the
   * other is cancelled. Fails only when every request sent has failed.
   */
  private hedged(
    send: (signal: AbortSignal) => Promise<GeminiResponse>,
    signal: AbortSignal,
    finishBy: number | undefined,
  ): Promise<{ response: GeminiResponse; hedged: boolean }> {
    return new Promise((resolve, reject) => {
      const controllers = [childOf(signal)];
      let pending = 1;
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const win = (response: GeminiResponse) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const c of controllers) c.abort(); // the slower request is cancelled
        resolve({ response, hedged: controllers.length > 1 });
      };
      const lose = (err: unknown) => {
        if (done || --pending > 0) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      };
      send(controllers[0]!.signal).then(win, lose);
      timer = setTimeout(() => {
        if (done || signal.aborted) return;
        if (finishBy !== undefined && finishBy - Date.now() < HEDGE_MIN_LEFT_MS) return;
        const second = childOf(signal);
        controllers.push(second);
        pending++;
        send(second.signal).then(win, lose);
      }, this.options.hedgeAfterMs ?? HEDGE_AFTER_MS);
    });
  }

  async generate(
    request: AssistantRequest,
    runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
    trace: AssistantTrace = { rounds: [] },
  ): Promise<AssistantModelResult> {
    const { prompt, promptVersion, answerSchema, tools, finishBy, ...input } = request;
    const turns: GeminiTurn[] = [{ role: 'user', text: JSON.stringify(input) }];
    const offered = new Set(tools.map((t) => t.name));
    const toolOutputs: unknown[] = [];
    const toolCalls: string[] = [];
    for (let round = 0; ; round++) {
      const offerTools =
        tools.length > 0 &&
        round < ASSISTANT_MAX_TOOL_ROUNDS &&
        (finishBy === undefined || finishBy - Date.now() > FINAL_ROUND_RESERVE_MS);
      const roundStarted = Date.now();
      const call = () =>
        this.hedged(
          (s) =>
            this.options.client.generate(
              {
                model: this.options.model,
                system: prompt,
                turns,
                tools: offerTools ? tools : [],
                // JSON mode only when no tool is offered; with tools the answer is JSON in the text.
                responseSchema: offerTools ? null : answerSchema,
                temperature: this.options.temperature ?? 0.2,
              },
              s,
            ),
          signal,
          finishBy,
        );
      // A 429 is retried once, and only when an answer round still fits before the deadline.
      const { response, hedged } = await call().catch(async (err: unknown) => {
        const fits = finishBy === undefined || finishBy - Date.now() > FINAL_ROUND_RESERVE_MS;
        if (!isRateLimited(err) || !fits || signal.aborted) throw err;
        await pause(RATE_LIMIT_RETRY_DELAY_MS, signal);
        return call();
      });
      const roundTrace = {
        ms: Date.now() - roundStarted,
        prompt_tokens: response.usage.promptTokens,
        output_tokens: response.usage.outputTokens,
        thought_tokens: response.usage.thoughtTokens ?? 0,
        tool_calls: [] as string[],
        tool_ms: 0,
        hedged,
      };
      trace.rounds.push(roundTrace);
      if (offerTools && response.functionCalls.length > 0) {
        const results: Extract<GeminiTurn, { role: 'tool' }>['results'] = [];
        const toolsStarted = Date.now();
        for (const call of response.functionCalls.slice(0, 3)) {
          const output = offered.has(call.name) ? await runTool(call.name, call.args) : { error: 'TOOL_NOT_AVAILABLE' };
          toolCalls.push(call.name);
          roundTrace.tool_calls.push(call.name);
          toolOutputs.push(output);
          results.push({ ...(call.id ? { id: call.id } : {}), name: call.name, response: { result: output } });
        }
        roundTrace.tool_ms = Date.now() - toolsStarted;
        turns.push({ role: 'model', raw: response.raw }, { role: 'tool', results });
        continue;
      }
      let raw: unknown;
      try {
        raw = extractJson(response.text ?? '');
      } catch {
        throw new AssistantAnswerError('The model answer is not JSON.');
      }
      this.logger.debug('assistant.gemini', {
        prompt_version: promptVersion,
        task: input.task,
        rounds: round + 1,
        tools: toolCalls,
        prompt_tokens: response.usage.promptTokens,
        output_tokens: response.usage.outputTokens,
      });
      return { raw, toolOutputs, toolCalls };
    }
  }
}
