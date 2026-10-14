/**
 * The one place that talks to Gemini on Vertex AI (Google Gen AI SDK, `@google/genai`).
 * Auth is Application Default Credentials only: the Cloud Run service account in gcp,
 * `gcloud auth application-default login` on a laptop. No API key is ever read.
 *
 * AdkGeminiAgentRuntime depends on the small GeminiClient interface below, so its loop is
 * tested with a fake client and no network.
 */
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content } from '@google/genai';

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** One turn of the exchange. `raw` is the model's own content, sent back unchanged (thought signatures). */
export type GeminiTurn =
  | { role: 'user'; text: string }
  | { role: 'model'; raw: unknown }
  | { role: 'tool'; results: { id?: string; name: string; response: Record<string, unknown> }[] };

export interface GeminiRequest {
  model: string;
  system: string;
  turns: GeminiTurn[];
  /** Read tools the model may call in this request; empty = it must answer now. */
  tools: { name: string; description: string; parameters: unknown }[];
  /** JSON Schema of the final answer. */
  responseSchema: Record<string, unknown>;
  temperature: number;
}

export interface GeminiResponse {
  functionCalls: GeminiFunctionCall[];
  text: string | null;
  /** The model content to append to the turns before the tool results. */
  raw: unknown;
  usage: { promptTokens: number; outputTokens: number };
}

export interface GeminiClient {
  generate(request: GeminiRequest, signal: AbortSignal): Promise<GeminiResponse>;
}

const withoutMeta = (schema: unknown) => {
  if (!schema || typeof schema !== 'object') return schema;
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  return rest;
};

const toContents = (turns: GeminiTurn[]): Content[] =>
  turns.map((turn): Content => {
    if (turn.role === 'user') return { role: 'user', parts: [{ text: turn.text }] };
    if (turn.role === 'model') return turn.raw as Content;
    return {
      role: 'user',
      parts: turn.results.map((r) => ({
        functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response: r.response },
      })),
    };
  });

export class VertexGeminiClient implements GeminiClient {
  private readonly ai: GoogleGenAI;

  constructor(options: { project: string; location: string }) {
    this.ai = new GoogleGenAI({ vertexai: true, project: options.project, location: options.location });
  }

  async generate(request: GeminiRequest, signal: AbortSignal): Promise<GeminiResponse> {
    const hasTools = request.tools.length > 0;
    const response = await this.ai.models.generateContent({
      model: request.model,
      contents: toContents(request.turns),
      config: {
        systemInstruction: request.system,
        temperature: request.temperature,
        abortSignal: signal,
        // The decision is small and time-bound: the lowest thinking level this model family allows.
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseJsonSchema: request.responseSchema,
        ...(hasTools
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: withoutMeta(t.parameters),
                  })),
                },
              ],
              toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
            }
          : {}),
      },
    });
    const content = response.candidates?.[0]?.content ?? { role: 'model', parts: [] };
    const functionCalls = (response.functionCalls ?? [])
      .filter((c) => typeof c.name === 'string' && c.name.length > 0)
      .map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name!, args: c.args ?? {} }));
    return {
      functionCalls,
      // The SDK's text getter warns on non-text parts, so it is read only for a final answer.
      text: functionCalls.length ? null : (response.text ?? null),
      raw: content,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens:
          (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    };
  }
}
