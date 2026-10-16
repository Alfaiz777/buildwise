/**
 * "Ask Qwikspot" model port, for every console's agent (L5 brand, L6 store; docs/05 §18). The
 * caller supplies the instruction, the answer schema, the data pack and the read-only tools;
 * the model returns a JSON answer that the caller validates and checks.
 */
export type AssistantTask = 'ANSWER' | 'BRIEF' | 'SUMMARY';

export interface AssistantToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AssistantRequest {
  prompt: string;
  promptVersion: string;
  /** JSON Schema of the answer (the model's structured output). */
  answerSchema: Record<string, unknown>;
  task: AssistantTask;
  page: string;
  question?: string;
  /** The data pack: computed numbers and names only, never a shopper's identity. */
  data: unknown;
  /** Read-only tools (at most 2 rounds); empty = one call. */
  tools: AssistantToolDeclaration[];
  /** When the caller stops waiting (epoch ms): no tool round is started that would not leave time to answer. */
  finishBy?: number;
}

export interface AssistantModelResult {
  /** The model's JSON answer, not yet validated. */
  raw: unknown;
  /** What the tools returned this run: numbers in the answer may come from these too. */
  toolOutputs: unknown[];
  toolCalls: string[];
}

/** One model call of an answer: how long it took, its tokens and the tools it asked for. */
export interface AssistantRound {
  ms: number;
  prompt_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  tool_calls: string[];
  /** Time spent running those tools before the next round. */
  tool_ms: number;
  /** The round's request was sent a second time because the first had not answered (HEDGE_AFTER_MS). */
  hedged: boolean;
}

/** Filled in as the rounds finish, so a run cut off by its deadline still shows what it did. */
export interface AssistantTrace {
  rounds: AssistantRound[];
}

export interface AssistantModel {
  readonly model: string;
  generate(
    request: AssistantRequest,
    runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
    trace?: AssistantTrace,
  ): Promise<AssistantModelResult>;
}
