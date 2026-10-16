/**
 * "Ask Qwikspot" — one answer, for any console (L5 brand, L6 store; docs/05 §18): Gemini within
 * its deadline, then checked (the answer's shape, no personal data, every number from the
 * data); otherwise the console's rules answer, the "Quick summary". One log line per answer,
 * and an ASSISTANT_QUESTION event for each question asked — never the question's text.
 */
import { containsPII, ungroundedNumbers, type ModelAnswer } from '../domain/assistant.js';
import { newId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { silentLogger } from '../lib/logger.js';
import type { AssistantModel, AssistantTask, AssistantToolDeclaration, AssistantTrace } from '../ports/assistant.js';
import type { EventInput } from './eventRecorder.js';
import type { z } from 'zod';

/** The whole answer, Gemini included, ends within 20 s; Gemini stops at 17 s and the rules answer. */
export const ASSISTANT_CEILING_MS = 20_000;
export const GEMINI_ASSISTANT_DEADLINE_MS = 17_000;

/**
 * What the person is looking at: the page's period and whether synthetic demo history counts —
 * the same two switches as the console's own numbers, so the AI talks about the same data.
 */
export interface AssistantScope {
  days: 7 | 28;
  includeHistory: boolean;
}
export const DEFAULT_SCOPE: AssistantScope = { days: 7, includeHistory: true };

export type AnswerSource = 'AI' | 'QUICK_SUMMARY';
export type AnswerFailure = 'NO_MODEL' | 'TIMEOUT' | 'ERROR' | 'INVALID' | 'UNGROUNDED' | 'PII';

export interface AssistantAnswer<P extends string = string> {
  answer: string;
  handoff_brief: string | null;
  next_action: { label: string; page: P; path: string } | null;
  used: string[];
  source: AnswerSource;
  generated_at: string;
  latency_ms: number;
}

/** A read-only tool the model may call: its declaration and what runs it. */
export interface AssistantTool {
  declaration: AssistantToolDeclaration;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface AssistantRun<P extends string> {
  /** Which console asks: the log line's prefix and the event's payload (role). */
  console: 'brand' | 'store' | 'platform';
  surface: 'ASK' | 'BRIEF' | 'CONVERSATION_SUMMARY';
  brandId: string;
  /** The store a store-console answer is about (the event's entity reference). */
  storeId?: string | null;
  task: AssistantTask;
  page: P;
  question?: string;
  data: unknown;
  prompt: string;
  promptVersion: string;
  /** Validates the model's answer (its next action may only name this console's pages). */
  schema: z.ZodType<ModelAnswer>;
  answerSchema: Record<string, unknown>;
  pathOf: (page: P) => string;
  tools?: AssistantTool[];
  quick: () => ModelAnswer;
  started: number;
}

class DeadlineExceeded extends Error {}

export class AssistantRunner {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      model?: AssistantModel;
      logger?: Logger;
      /** Records the ASSISTANT_QUESTION event (EventRecorder.record). */
      recordEvent?: (event: EventInput) => Promise<unknown>;
      now?: () => Date;
      deadlineMs?: number;
    },
  ) {
    this.logger = deps.logger ?? silentLogger;
  }

  get modelName(): string | null {
    return this.deps.model?.model ?? null;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async run<P extends string>(spec: AssistantRun<P>): Promise<AssistantAnswer<P>> {
    let failure: AnswerFailure | null = null;
    let ai: ModelAnswer | null = null;
    let toolCalls: string[] = [];
    let geminiMs: number | null = null;
    /** For an ERROR: the error's kind and HTTP status (never its message, which may quote data). */
    let errorKind: string | null = null;
    const trace: AssistantTrace = { rounds: [] };
    const model = this.deps.model;
    if (!model) failure = 'NO_MODEL';
    else {
      const geminiStarted = Date.now();
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const tools = new Map((spec.tools ?? []).map((t) => [t.declaration.name, t]));
      const deadlineMs = this.deps.deadlineMs ?? GEMINI_ASSISTANT_DEADLINE_MS;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new DeadlineExceeded());
            controller.abort();
          }, deadlineMs);
        });
        const result = await Promise.race([
          model.generate(
            {
              prompt: spec.prompt,
              promptVersion: spec.promptVersion,
              answerSchema: spec.answerSchema,
              task: spec.task,
              page: spec.page,
              ...(spec.question !== undefined ? { question: spec.question } : {}),
              data: spec.data,
              tools: [...tools.values()].map((t) => t.declaration),
              finishBy: geminiStarted + deadlineMs,
            },
            async (name, args) => tools.get(name)?.run(args) ?? { error: 'TOOL_NOT_AVAILABLE' },
            controller.signal,
            trace,
          ),
          deadline,
        ]);
        toolCalls = result.toolCalls;
        const parsed = spec.schema.safeParse(result.raw);
        if (!parsed.success) failure = 'INVALID';
        else {
          const a = parsed.data;
          const text = `${a.answer} ${a.handoff_brief ?? ''} ${a.next_action?.label ?? ''}`;
          if (containsPII(text)) failure = 'PII';
          else if (ungroundedNumbers(text, spec.data, result.toolOutputs, spec.question ?? '').length > 0)
            failure = 'UNGROUNDED';
          else ai = a;
        }
      } catch (err) {
        failure = err instanceof DeadlineExceeded ? 'TIMEOUT' : 'ERROR';
        if (failure === 'ERROR') {
          const status = (err as { status?: unknown }).status;
          errorKind = `${err instanceof Error ? err.name : typeof err}${typeof status === 'number' ? ` ${status}` : ''}`;
        }
      } finally {
        clearTimeout(timer);
        geminiMs = Date.now() - geminiStarted;
      }
    }
    const chosen = ai ?? spec.quick();
    const source: AnswerSource = ai ? 'AI' : 'QUICK_SUMMARY';
    const latency = Date.now() - spec.started;
    // Brand / store / page / outcome only: never the question, the answer or a customer.
    this.logger.info(`${spec.console}_assistant.answer`, {
      brand_id: spec.brandId,
      ...(spec.storeId ? { store_id: spec.storeId } : {}),
      surface: spec.surface,
      page: spec.page,
      source,
      failure,
      latency_ms: latency,
      gemini_ms: geminiMs,
      tool_calls: toolCalls,
      ...(errorKind ? { error_kind: errorKind } : {}),
      // Where the time went: the data's size and each Gemini round (a cut-off round is not listed).
      data_chars: JSON.stringify(spec.data ?? null).length,
      rounds: trace.rounds,
    });
    if (spec.task === 'ANSWER' && this.deps.recordEvent) {
      const at = this.now().toISOString();
      await this.deps
        .recordEvent({
          brandId: spec.brandId,
          eventType: 'ASSISTANT_QUESTION',
          source: 'QWIKSPOT',
          entityReference: spec.storeId ?? null,
          payload: {
            console: spec.console.toUpperCase(),
            role: spec.console.toUpperCase(),
            page: spec.page,
            source,
            failure,
            latency_ms: latency,
          },
          idempotencyKey: newId('aq'),
          at,
        })
        .catch(() => undefined); // analytics never fails the answer
    }
    const next = chosen.next_action as { label: string; page: P } | null | undefined;
    return {
      answer: chosen.answer,
      handoff_brief: chosen.handoff_brief ?? null,
      next_action: next ? { label: next.label, page: next.page, path: spec.pathOf(next.page) } : null,
      used: chosen.used ?? [],
      source,
      generated_at: this.now().toISOString(),
      latency_ms: latency,
    };
  }
}

/** Briefs written once and reused: 10 minutes for an AI one, 1 minute for a Quick summary. */
export const BRIEF_CACHE_MS = 10 * 60_000;
const QUICK_BRIEF_CACHE_MS = 60_000;

export class BriefCache<V extends { source: AnswerSource }> {
  private readonly rows = new Map<string, { at: number; ttl: number; value: V }>();

  get(key: string): V | null {
    const row = this.rows.get(key);
    return row && Date.now() - row.at < row.ttl ? row.value : null;
  }

  set(key: string, value: V) {
    this.rows.set(key, { at: Date.now(), ttl: value.source === 'AI' ? BRIEF_CACHE_MS : QUICK_BRIEF_CACHE_MS, value });
  }

  /** Forget every brief whose key starts with `prefix` (Reset demo). */
  forget(prefix: string) {
    for (const key of this.rows.keys()) if (key.startsWith(prefix)) this.rows.delete(key);
  }
}
