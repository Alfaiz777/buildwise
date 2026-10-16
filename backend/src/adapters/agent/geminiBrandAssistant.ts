/**
 * "Ask Qwikspot" on Gemini (L5, docs/05 §18): one request with the whole data pack, at most two
 * rounds of read tools, then a structured answer. Cancelled by the caller's signal (the
 * service's 17 s deadline). Never writes anything; the tools are read-only by construction.
 */
import {
  BRAND_ASSISTANT_PROMPT,
  BRAND_ASSISTANT_PROMPT_VERSION,
  BrandAnswerSchema,
  brandAnswerJsonSchema,
} from '../../domain/brandAssistant.js';
import { extractJson } from '../../domain/agentPrompt.js';
import type { Logger } from '../../lib/logger.js';
import { silentLogger } from '../../lib/logger.js';
import type {
  BrandAssistantModel,
  BrandModelInput,
  BrandModelResult,
  BrandModelTools,
} from '../../ports/brandAssistant.js';
import type { GeminiClient, GeminiTurn } from './geminiClient.js';

export const BRAND_MAX_TOOL_ROUNDS = 2;

const TOOLS = [
  {
    name: 'get_store',
    description: "One store's details (stock age, fill rate, refusals) and its holds right now. No shopper details.",
    parameters: {
      type: 'object',
      properties: { store_id: { type: 'string', description: 'A store_id from data.stores' } },
      required: ['store_id'],
    },
  },
  {
    name: 'list_conversations',
    description: 'Recent conversations with what happened (product, hold, refusal, handoff). No shopper details.',
    parameters: {
      type: 'object',
      properties: {
        without_hold: { type: 'boolean' },
        refused_by_store: { type: 'boolean' },
        with_person: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
  },
];

export class BrandAnswerError extends Error {}

export class GeminiBrandAssistant implements BrandAssistantModel {
  private readonly logger: Logger;

  constructor(
    private readonly options: { client: GeminiClient; model: string; logger?: Logger; temperature?: number },
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  get model() {
    return this.options.model;
  }

  async generate(input: BrandModelInput, tools: BrandModelTools, signal: AbortSignal): Promise<BrandModelResult> {
    const turns: GeminiTurn[] = [{ role: 'user', text: JSON.stringify(input) }];
    const toolOutputs: unknown[] = [];
    const toolCalls: string[] = [];
    for (let round = 0; ; round++) {
      const offerTools = round < BRAND_MAX_TOOL_ROUNDS;
      const response = await this.options.client.generate(
        {
          model: this.options.model,
          system: BRAND_ASSISTANT_PROMPT,
          turns,
          tools: offerTools ? TOOLS : [],
          responseSchema: brandAnswerJsonSchema(),
          temperature: this.options.temperature ?? 0.2,
        },
        signal,
      );
      if (offerTools && response.functionCalls.length > 0) {
        const results: Extract<GeminiTurn, { role: 'tool' }>['results'] = [];
        for (const call of response.functionCalls.slice(0, 3)) {
          const base = { ...(call.id ? { id: call.id } : {}), name: call.name };
          let output: unknown;
          if (call.name === 'get_store') output = await tools.get_store({ store_id: String(call.args.store_id ?? '') });
          else if (call.name === 'list_conversations')
            output = await tools.list_conversations(call.args as Parameters<BrandModelTools['list_conversations']>[0]);
          else output = { error: 'TOOL_NOT_AVAILABLE' };
          toolCalls.push(call.name);
          toolOutputs.push(output);
          results.push({ ...base, response: { result: output } });
        }
        turns.push({ role: 'model', raw: response.raw }, { role: 'tool', results });
        continue;
      }
      let raw: unknown;
      try {
        raw = extractJson(response.text ?? '');
      } catch {
        throw new BrandAnswerError('The model answer is not JSON.');
      }
      const parsed = BrandAnswerSchema.safeParse(raw);
      if (!parsed.success) throw new BrandAnswerError('The model answer does not match the schema.');
      this.logger.debug('brand_assistant.gemini', {
        prompt_version: BRAND_ASSISTANT_PROMPT_VERSION,
        task: input.task,
        rounds: round + 1,
        tools: toolCalls,
        prompt_tokens: response.usage.promptTokens,
        output_tokens: response.usage.outputTokens,
      });
      return { answer: parsed.data, toolOutputs, toolCalls };
    }
  }
}
