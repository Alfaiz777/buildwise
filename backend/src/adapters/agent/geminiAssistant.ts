/**
 * "Ask Qwikspot" on Gemini (docs/05 §18), for every console's agent: one request with the whole
 * data pack, at most two rounds of the caller's read-only tools, then a structured JSON answer.
 * Cancelled by the caller's signal (its deadline). It never writes anything.
 */
import { extractJson } from '../../domain/agentPrompt.js';
import type { Logger } from '../../lib/logger.js';
import { silentLogger } from '../../lib/logger.js';
import type { AssistantModel, AssistantModelResult, AssistantRequest } from '../../ports/assistant.js';
import type { GeminiClient, GeminiTurn } from './geminiClient.js';

export const ASSISTANT_MAX_TOOL_ROUNDS = 2;

export class AssistantAnswerError extends Error {}

export class GeminiAssistant implements AssistantModel {
  private readonly logger: Logger;

  constructor(
    private readonly options: { client: GeminiClient; model: string; logger?: Logger; temperature?: number },
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  get model() {
    return this.options.model;
  }

  async generate(
    request: AssistantRequest,
    runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<AssistantModelResult> {
    const { prompt, promptVersion, answerSchema, tools, ...input } = request;
    const turns: GeminiTurn[] = [{ role: 'user', text: JSON.stringify(input) }];
    const offered = new Set(tools.map((t) => t.name));
    const toolOutputs: unknown[] = [];
    const toolCalls: string[] = [];
    for (let round = 0; ; round++) {
      const offerTools = tools.length > 0 && round < ASSISTANT_MAX_TOOL_ROUNDS;
      const response = await this.options.client.generate(
        {
          model: this.options.model,
          system: prompt,
          turns,
          tools: offerTools ? tools : [],
          responseSchema: answerSchema,
          temperature: this.options.temperature ?? 0.2,
        },
        signal,
      );
      if (offerTools && response.functionCalls.length > 0) {
        const results: Extract<GeminiTurn, { role: 'tool' }>['results'] = [];
        for (const call of response.functionCalls.slice(0, 3)) {
          const output = offered.has(call.name) ? await runTool(call.name, call.args) : { error: 'TOOL_NOT_AVAILABLE' };
          toolCalls.push(call.name);
          toolOutputs.push(output);
          results.push({ ...(call.id ? { id: call.id } : {}), name: call.name, response: { result: output } });
        }
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
