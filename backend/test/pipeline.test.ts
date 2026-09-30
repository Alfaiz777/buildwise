import { describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { SimulatorMessagingProvider } from '../src/adapters/messaging/simulatorMessagingProvider.js';
import { runAgentRuntime } from '../src/application/conversation/agentStage.js';
import {
  CONTINUE,
  ConversationPipeline,
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineStageName,
} from '../src/application/conversation/pipeline.js';
import { decisionInput, stubExecutor } from './agentFixtures.js';
import type { AgentRuntime } from '../src/ports/agent.js';

const recordingStage = (name: PipelineStageName, log: string[]): PipelineStage => ({
  name,
  async run(context) {
    log.push(name);
    if (name === 'IDENTITY') context.customerId = 'cust_1';
    if (name === 'CONVERSATION_STATE') context.conversationId = 'conv_1';
    return CONTINUE;
  },
});

const allStages = (log: string[], replace: Partial<Record<PipelineStageName, PipelineStage>> = {}) =>
  PIPELINE_STAGES.map((name) => replace[name] ?? recordingStage(name, log));

const simulatorMessage = (text: string) =>
  new SimulatorMessagingProvider().normalizeInbound({
    brandId: 'brd_1',
    receivedAt: '2026-10-01T10:00:00.000Z',
    body: { simulator_customer_ref: 'c1', client_message_id: 'm1', content: { type: 'TEXT', text } },
  })[0]!;

describe('ConversationPipeline foundation', () => {
  it('fixes the approved stage order (docs/03 §8.2)', () => {
    expect(PIPELINE_STAGES).toEqual([
      'IDEMPOTENCY',
      'IDENTITY',
      'HANDSHAKE',
      'CONVERSATION_STATE',
      'POLICY',
      'AGENT',
      'GUARDRAIL',
      'TOOLS',
      'PERSISTENCE',
      'OUTBOUND',
      'OUTCOME',
    ]);
  });

  it('refuses wiring with a missing, duplicated or reordered stage', () => {
    const log: string[] = [];
    const stages = allStages(log);
    expect(() => new ConversationPipeline(stages.slice(1))).toThrow(/must be exactly/);
    expect(() => new ConversationPipeline([...stages, stages[0]!])).toThrow(/must be exactly/);
    expect(() => new ConversationPipeline([stages[1]!, stages[0]!, ...stages.slice(2)])).toThrow(/must be exactly/);
  });

  it('runs every stage in order for one inbound message', async () => {
    const log: string[] = [];
    const result = await new ConversationPipeline(allStages(log)).handleInbound(simulatorMessage('hello'));
    expect(log).toEqual([...PIPELINE_STAGES]);
    expect(result.stoppedAt).toBeNull();
    expect(result.completedStages).toEqual([...PIPELINE_STAGES]);
  });

  it('a stage can stop the run (e.g. duplicate delivery at IDEMPOTENCY)', async () => {
    const log: string[] = [];
    const duplicate: PipelineStage = { name: 'IDEMPOTENCY', run: async () => ({ stop: true, reason: 'DUPLICATE' }) };
    const result = await new ConversationPipeline(allStages(log, { IDEMPOTENCY: duplicate })).handleInbound(
      simulatorMessage('hello'),
    );
    expect(log).toEqual([]);
    expect(result.stoppedAt).toEqual({ stage: 'IDEMPOTENCY', reason: 'DUPLICATE' });
  });

  it('the agent run calls whichever AgentRuntime is injected and validates the decision contract', async () => {
    const result = await runAgentRuntime(
      new MockAgentRuntime(),
      decisionInput({ type: 'TEXT', text: 'I want a person' }),
      stubExecutor(),
    );
    expect(result).toMatchObject({
      ok: true,
      decision: { runtime: 'MOCK', next_best_action: { action: 'HUMAN_HANDOFF' } },
    });
  });

  it('rejects a decision that claims a different runtime (MOCK can never pose as ADK_GEMINI)', async () => {
    const impostor: AgentRuntime = {
      runtime: 'MOCK',
      decide: async (input, tools) => ({
        ...(await new MockAgentRuntime().decide(input, tools)),
        runtime: 'ADK_GEMINI',
      }),
    };
    const result = await runAgentRuntime(impostor, decisionInput({ type: 'TEXT', text: 'hi' }), stubExecutor());
    expect(result).toEqual({ ok: false, reason: 'INVALID_OUTPUT', repaired: true });
  });

  it('the ToolExecutor blocks unknown tools; there is no record_outcome tool', async () => {
    expect(await stubExecutor().execute({ tool: 'record_outcome', input: {} })).toMatchObject({
      status: 'BLOCKED',
      reasonCode: 'UNKNOWN_TOOL',
    });
  });
});

describe('ConversationPipeline role assumptions', () => {
  it('the customer is identified by channel identity only — no console role, principal or scope is involved', async () => {
    const message = simulatorMessage('hello');
    expect(Object.keys(message).sort()).toEqual([
      'brandId',
      'channel',
      'content',
      'externalCustomerRef',
      'externalMessageId',
      'receivedAt',
    ]);
    expect(message.externalCustomerRef).toBe('sim:c1');

    const result = await new ConversationPipeline(allStages([])).handleInbound(message);
    const context = JSON.stringify(result.context);
    for (const consoleConcept of ['role', 'scope', 'PLATFORM_ADMIN', 'BRAND_ADMIN', 'RETAIL_ADMIN']) {
      expect(context).not.toContain(consoleConcept);
    }
  });
});
