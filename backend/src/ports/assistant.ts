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
}

export interface AssistantModelResult {
  /** The model's JSON answer, not yet validated. */
  raw: unknown;
  /** What the tools returned this run: numbers in the answer may come from these too. */
  toolOutputs: unknown[];
  toolCalls: string[];
}

export interface AssistantModel {
  readonly model: string;
  generate(
    request: AssistantRequest,
    runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<AssistantModelResult>;
}
