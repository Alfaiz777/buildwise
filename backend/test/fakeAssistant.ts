/**
 * Test doubles for "Ask Qwikspot" (brand and store agents): a fake model that answers what the
 * test returns for each request, and a logger that keeps the answer lines.
 */
import type { ModelAnswer } from '../src/domain/assistant.js';
import type { Logger } from '../src/lib/logger.js';
import type { AssistantModel, AssistantRequest } from '../src/ports/assistant.js';

export class FakeAssistantModel implements AssistantModel {
  readonly model = 'fake-assistant-model';
  inputs: AssistantRequest[] = [];
  constructor(private readonly reply: (input: AssistantRequest) => Promise<ModelAnswer> | ModelAnswer) {}
  async generate(input: AssistantRequest, _runTool: unknown, signal: AbortSignal) {
    this.inputs.push(input);
    const raw = await this.reply(input);
    if (signal.aborted) throw new Error('aborted');
    return { raw, toolOutputs: [], toolCalls: [] };
  }
}

/** A logger that keeps every info line; `answers()` are the Ask Qwikspot answer lines. */
export function answerLogs(name = 'brand_assistant.answer') {
  const lines: { message: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info: (message, fields) => lines.push({ message, fields: fields ?? {} }),
  };
  return { lines, logger, answers: () => lines.filter((l) => l.message === name) };
}
