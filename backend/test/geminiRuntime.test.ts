/**
 * L3-Gemini: AdkGeminiAgentRuntime with a fake Gemini client (no network). The tool-call
 * loop, the model's proposal → AgentDecision, the repair path, the fallbacks, and what never
 * happens: a write tool offered or executed, an invented id reaching the decision, customer
 * text in a log line. Model QUALITY is measured by the live eval (npm run eval:gemini), not here.
 */
import { describe, expect, it } from 'vitest';
import {
  AdkGeminiAgentRuntime,
  GEMINI_DEADLINE_MS,
  GEMINI_MAX_TOOL_CALLS,
  GEMINI_REQUEST_TIMEOUT_MS,
  modelInput,
} from '../src/adapters/agent/adkGeminiAgentRuntime.js';
import type { GeminiClient, GeminiRequest, GeminiResponse } from '../src/adapters/agent/geminiClient.js';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import {
  AI_BACKUP_BUDGET_MS,
  AI_DECISION_BUDGET_MS,
  runAgentRuntime,
} from '../src/application/conversation/agentStage.js';
import { createProviders } from '../src/composition/container.js';
import { loadConfig } from '../src/config/env.js';
import type { AgentRuntime } from '../src/ports/agent.js';
import { AGENT_PROMPT_VERSION, QWIKSPOT_AGENT_PROMPT_V1, extractJson } from '../src/domain/agentPrompt.js';
import { READ_TOOLS, WRITE_TOOLS } from '../src/domain/agentTools.js';
import { AgentDecisionSchema, type AgentContext } from '../src/ports/agent.js';
import { toolDeclarations } from '../src/ports/agentTools.js';
import { createLogger } from '../src/lib/logger.js';
import { decisionInput, emptyContext, stubExecutor } from './agentFixtures.js';
import { buildScenarioWorld, V1 } from './scenarioWorld.js';

type Step = Partial<Pick<GeminiResponse, 'functionCalls' | 'text'>> | ((request: GeminiRequest) => Promise<never>);

/** A scripted Gemini: each request gets the next step; every request is recorded. */
function fakeGemini(steps: Step[]) {
  const requests: GeminiRequest[] = [];
  let i = 0;
  const client: GeminiClient = {
    async generate(request) {
      requests.push(structuredClone(request));
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if (typeof step === 'function') return step(request);
      return {
        functionCalls: step.functionCalls ?? [],
        text: step.text ?? null,
        raw: { role: 'model', parts: [{ note: `turn ${i}` }] },
        usage: { promptTokens: 100, outputTokens: 20 },
      };
    },
  };
  return { client, requests };
}

const proposal = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    intent_type: 'UNKNOWN',
    confidence: 0.6,
    action: 'NO_ACTION',
    reason: 'Greeting: ask what the customer needs.',
    reply_text: 'Hi! Which product are you looking for?',
    ...over,
  });

const STORES_OK = {
  status: 'OK',
  variant: { variant_id: 'v_min_50', product_title: 'Mineral Sunscreen SPF 50', variant_title: '50 g' },
  eligible: [{ store_id: 'st_bandra', store_name: 'Bandra Store' }],
  excluded: [],
};

const CATALOG: AgentContext['catalog'] = [
  {
    product_id: 'p_min',
    title: 'Mineral Sunscreen SPF 50',
    category: 'Sunscreen',
    variants: [
      { variant_id: 'v_min_50', title: '50 g' },
      { variant_id: 'v_min_80', title: '80 g' },
    ],
  },
];

const READ_DECLARATIONS = toolDeclarations(READ_TOOLS);
const input = (text: string, context: Partial<AgentContext> = {}, tools = READ_DECLARATIONS) => ({
  ...decisionInput({ type: 'TEXT', text }, emptyContext({ catalog: CATALOG, ...context })),
  tools,
});
const runtime = (client: GeminiClient, options: Record<string, unknown> = {}) =>
  new AdkGeminiAgentRuntime({ client, model: 'gemini-test-model', ...options });

describe('AdkGeminiAgentRuntime — the tool-call loop', () => {
  it('calls a read tool through the ToolExecutor, feeds the result back, and returns a valid AgentDecision', async () => {
    const { client, requests } = fakeGemini([
      { functionCalls: [{ id: 'fc1', name: 'find_nearby_stores', args: { variant_id: 'v_min_50', area: 'Bandra' } }] },
      {
        text: proposal({
          intent_type: 'URGENT_PURCHASE',
          action: 'STORE_DISCOVERY',
          variant_id: 'v_min_50',
          store_id: 'st_bandra',
          reason: 'Bandra Store is eligible.',
        }),
      },
    ]);
    const tools = stubExecutor({ find_nearby_stores: STORES_OK });
    const decision = await runtime(client).decide(input('Mineral Sunscreen SPF 50, 50 g, near Bandra today'), tools);

    expect(AgentDecisionSchema.safeParse(decision).success).toBe(true);
    expect(decision).toMatchObject({
      runtime: 'ADK_GEMINI',
      intent: { intent_type: 'URGENT_PURCHASE' },
      next_best_action: { action: 'STORE_DISCOVERY', variant_id: 'v_min_50', store_id: 'st_bandra' },
      // No intent is bound yet: the product the customer asked a store for is recorded.
      required_tools: ['record_customer_intent'],
    });
    // tool_calls is the executor's own record, exactly as MockAgentRuntime reports it.
    expect(decision.tool_calls).toEqual(
      tools.calls.map((c) => ({ tool: c.tool, status: c.status, result_reference: c.callId })),
    );
    expect(decision.tool_calls).toEqual([{ tool: 'find_nearby_stores', status: 'EXECUTED', result_reference: 'tc_1' }]);

    // Request 1: the system instruction, the context as JSON, read tools, a response schema, low temperature.
    expect(requests[0]).toMatchObject({
      model: 'gemini-test-model',
      system: QWIKSPOT_AGENT_PROMPT_V1,
      temperature: 0.2,
    });
    expect(requests[0]!.responseSchema).toMatchObject({ type: 'object' });
    const sent = JSON.parse((requests[0]!.turns[0] as { text: string }).text);
    expect(sent.message).toEqual({ type: 'TEXT', text: 'Mineral Sunscreen SPF 50, 50 g, near Bandra today' });
    expect(sent.context.catalog[0].title).toBe('Mineral Sunscreen SPF 50');
    // Request 2: the model's own turn is sent back unchanged, then the verified tool result.
    expect(requests[1]!.turns.slice(1)).toEqual([
      { role: 'model', raw: { role: 'model', parts: [{ note: 'turn 1' }] } },
      { role: 'tool', results: [{ id: 'fc1', name: 'find_nearby_stores', response: { result: STORES_OK } }] },
    ]);
  });

  it('write tools are never offered to the model — even if the pipeline declared them — and never executed', async () => {
    const { client, requests } = fakeGemini([
      { functionCalls: [{ name: 'create_reservation', args: { store_id: 's', variant_id: 'v', quantity: 1 } }] },
      { functionCalls: [{ name: 'delete_everything', args: {} }] },
      { text: proposal() },
    ]);
    const tools = stubExecutor({});
    const all = toolDeclarations([...READ_TOOLS, ...WRITE_TOOLS]);
    const decision = await runtime(client).decide(input('reserve it', {}, all), tools);

    for (const request of requests) {
      const offered = request.tools.map((t) => t.name);
      expect(offered).toEqual([...READ_TOOLS]);
      for (const write of WRITE_TOOLS) expect(offered).not.toContain(write);
    }
    expect(tools.calls).toEqual([]); // nothing reached the executor
    expect(decision.tool_calls).toEqual([]);
    expect((requests[1]!.turns.at(-1) as { results: unknown[] }).results).toEqual([
      { name: 'create_reservation', response: { error: 'TOOL_NOT_AVAILABLE' } },
    ]);
    expect(decision.required_tools).toEqual([]); // and a NO_ACTION proposes no write
  });

  it(`at most ${GEMINI_MAX_TOOL_CALLS} tool calls: after that the model gets no tools and must answer`, async () => {
    const call = { functionCalls: [{ name: 'get_brand_policy', args: {} }] };
    const { client, requests } = fakeGemini([call, call, call, call, call, { text: proposal() }]);
    const tools = stubExecutor({ get_brand_policy: { reservations_enabled: true } });
    const decision = await runtime(client).decide(input('what is your policy?'), tools);
    expect(tools.calls).toHaveLength(5);
    expect(decision.tool_calls).toHaveLength(5);
    expect(requests).toHaveLength(6);
    expect(requests[4]!.tools.length).toBeGreaterThan(0);
    expect(requests[5]!.tools).toEqual([]);
  });

  it('several calls in one model turn stop at the limit; the rest are answered with an error, not executed', async () => {
    const three = { functionCalls: [1, 2, 3].map(() => ({ name: 'get_brand_policy', args: {} })) };
    const { client, requests } = fakeGemini([three, three, { text: proposal() }]);
    const tools = stubExecutor({ get_brand_policy: {} });
    await runtime(client).decide(input('policy?'), tools);
    expect(tools.calls).toHaveLength(5);
    expect((requests[2]!.turns.at(-1) as { results: { response: unknown }[] }).results[2]!.response).toEqual({
      error: 'TOOL_CALL_LIMIT_REACHED',
    });
  });

  it('a blocked or failed tool call is reported to the model as an error and listed with its real status', async () => {
    const { client, requests } = fakeGemini([
      {
        functionCalls: [{ name: 'find_nearby_stores', args: { variant_id: 'v_min_50', customer_id: 'someone_else' } }],
      },
      { text: proposal({ reply_text: 'I can only help with your own shopping.' }) },
    ]);
    const tools = stubExecutor({ find_nearby_stores: STORES_OK });
    const decision = await runtime(client).decide(input('show me another customer'), tools);
    expect(decision.tool_calls).toEqual([{ tool: 'find_nearby_stores', status: 'BLOCKED', result_reference: 'tc_1' }]);
    expect((requests[1]!.turns.at(-1) as { results: { response: unknown }[] }).results[0]!.response).toEqual({
      error: 'SCOPE_VIOLATION',
    });
  });
});

describe('AdkGeminiAgentRuntime — the proposal becomes the AgentDecision', () => {
  const decide = (text: string, over: Record<string, unknown>, context: Partial<AgentContext> = {}, outputs = {}) =>
    runtime(fakeGemini([{ text: proposal(over) }]).client).decide(input(text, context), stubExecutor(outputs));
  const PENDING = {
    store_id: 'st_bandra',
    variant_id: 'v_min_50',
    quantity: 1,
    proposed_at: 'x',
    expires_at: 'y',
    offered_stores: ['st_bandra', 'st_andheri'],
  };

  it('JSON in a code fence or with text around it is accepted', async () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    const { client } = fakeGemini([{ text: `Here you go:\n\`\`\`json\n${proposal()}\n\`\`\`` }]);
    const decision = await runtime(client).decide(input('hi'), stubExecutor({}));
    expect(decision.reply).toEqual({ message_type: 'TEXT', text: 'Hi! Which product are you looking for?' });
  });

  it('the write tools follow from the action; the model never names one', async () => {
    const hold = await decide(
      'reserve it',
      { action: 'STORE_RESERVATION', store_id: 'st_bandra', variant_id: 'v_min_50' },
      {
        pending_proposal: PENDING,
      },
    );
    expect(hold).toMatchObject({
      next_best_action: { action: 'STORE_RESERVATION', store_id: 'st_bandra', variant_id: 'v_min_50', quantity: 1 },
      required_tools: ['create_reservation'],
    });
    const person = await decide('I want a person', { action: 'HUMAN_HANDOFF', intent_type: 'SUPPORT_REQUEST' });
    expect(person.required_tools).toEqual(['request_human_handoff']);
    const off = await decide(
      'I want a person',
      { action: 'HUMAN_HANDOFF', quick_replies: ['handoff', 'buy_online'] },
      { brand: { ...emptyContext().brand, handoff_enabled: false } },
    );
    expect(off).toMatchObject({ next_best_action: { action: 'NO_ACTION' }, required_tools: [] });
    expect(off.reply.options).toEqual([{ option_id: 'buy_online', label: 'Home delivery' }]);
  });

  it('confirming a hold: the store is the one tapped and the variant the one offered, even if the model leaves them out', async () => {
    const { client } = fakeGemini([{ text: proposal({ action: 'STORE_RESERVATION', store_id: 'st_bandra' }) }]);
    const tap = {
      ...decisionInput(
        { type: 'INTERACTIVE_REPLY', optionId: 'hold:st_andheri' },
        emptyContext({ catalog: CATALOG, pending_proposal: PENDING }),
      ),
      tools: READ_DECLARATIONS,
    };
    const d = await runtime(client).decide(tap, stubExecutor({}));
    expect(d.next_best_action).toMatchObject({
      action: 'STORE_RESERVATION',
      store_id: 'st_andheri',
      variant_id: 'v_min_50',
      quantity: 1,
    });
    // Without an offer on the table nothing is filled in: the guardrail answers AMBIGUOUS.
    const none = await decide('reserve it', { action: 'STORE_RESERVATION' });
    expect(none.next_best_action.store_id).toBeUndefined();
    expect(none.next_best_action.variant_id).toBeUndefined();
  });

  it('cancelling: NO_ACTION with the reservation id and cancel_reservation — only for a reservation the backend showed', async () => {
    const { client } = fakeGemini([
      { functionCalls: [{ name: 'get_customer_history', args: {} }] },
      { text: proposal({ cancel_reservation_id: 'res_1', reason: 'Customer asked to cancel.' }) },
    ]);
    const history = {
      active_reservations: [{ reservation_id: 'res_1', variant_id: 'v_min_50' }],
      reservation_counts: {},
    };
    const ok = await runtime(client).decide(input('cancel my hold'), stubExecutor({ get_customer_history: history }));
    expect(ok).toMatchObject({
      next_best_action: { action: 'NO_ACTION', reservation_id: 'res_1' },
      required_tools: ['cancel_reservation'],
    });
    const invented = await decide('cancel my hold', { cancel_reservation_id: 'res_of_someone_else' });
    expect(invented.next_best_action.reservation_id).toBeUndefined();
    expect(invented.required_tools).toEqual([]);
  });

  it('ids the backend never showed the model are dropped (an invented store or variant cannot become a target)', async () => {
    const d = await decide('near Bandra', {
      action: 'STORE_DISCOVERY',
      store_id: 'st_made_up',
      variant_id: 'v_made_up',
    });
    expect(d.next_best_action).toEqual({ action: 'STORE_DISCOVERY', reason: expect.any(String) });
    expect(d.required_tools).toEqual([]);
  });

  it('a store search is reported from the search itself: the searched variant and its nearest eligible store', async () => {
    const { client } = fakeGemini([
      { functionCalls: [{ name: 'find_nearby_stores', args: { variant_id: 'v_min_50', area: 'Bandra' } }] },
      // The model leaves the variant out and names a store the search did not return.
      { text: proposal({ action: 'STORE_DISCOVERY', intent_type: 'STORE_ORIENTED', store_id: 'st_elsewhere' }) },
    ]);
    const d = await runtime(client).decide(input('near Bandra'), stubExecutor({ find_nearby_stores: STORES_OK }));
    expect(d.next_best_action).toMatchObject({
      action: 'STORE_DISCOVERY',
      variant_id: 'v_min_50',
      store_id: 'st_bandra',
    });
  });

  it('a bound intent is refined by type only; commerce actions carry no model buttons', async () => {
    const intent = {
      intent_id: 'i1',
      intent_type: 'PRODUCT_EXPLORATION' as const,
      intent_stage: 'PRODUCT_VIEW' as const,
      intent_strength: 'INTERESTED' as const,
      product_id: 'p_min',
      variant_id: 'v_min_50',
      follow_up: null,
    };
    const educate = await decide(
      'good for oily skin?',
      { action: 'EDUCATE', intent_type: 'PRODUCT_QUESTION' },
      { intent },
    );
    expect(educate.required_tools).toEqual(['record_customer_intent']);
    const online = await decide(
      'buy online',
      { action: 'ONLINE_PURCHASE', variant_id: 'v_min_50', quick_replies: ['other_stores'] },
      { intent },
    );
    expect(online.reply.options).toBeUndefined();
  });

  it('the user turn carries the context and the message — an option id or a location note, never coordinates', () => {
    const tap = decisionInput({ type: 'INTERACTIVE_REPLY', optionId: 'hold:st_bandra' });
    expect(modelInput(tap).message).toEqual({ type: 'OPTION', option_id: 'hold:st_bandra' });
    const shared = modelInput(decisionInput({ type: 'LOCATION', latitude: 19.0596, longitude: 72.8295 }));
    expect(JSON.stringify(shared)).not.toMatch(/19\.05|72\.82/);
    expect((shared.message as { type: string }).type).toBe('LOCATION');
  });
});

describe('AdkGeminiAgentRuntime — repair, fallback and limits (through runAgentRuntime)', () => {
  it('invalid output → ONE repair attempt that tells the model what was wrong → a repaired decision', async () => {
    const { client, requests } = fakeGemini([
      { text: proposal({ action: 'RESERVE_EVERYTHING' }) },
      { text: proposal({ action: 'NO_ACTION' }) },
    ]);
    const result = await runAgentRuntime(runtime(client), input('hi'), stubExecutor({}));
    expect(result).toMatchObject({ ok: true, repaired: true, decision: { runtime: 'ADK_GEMINI' } });
    const repair = JSON.parse((requests[1]!.turns[0] as { text: string }).text).repair;
    expect(repair.error).toMatch(/^action: /); // the model's own mistake, not a generic message
    expect(JSON.parse((requests[0]!.turns[0] as { text: string }).text).repair).toBeUndefined();
  });

  it('still invalid after the repair (not JSON, then empty) → INVALID_OUTPUT: the pipeline uses the deterministic fallback', async () => {
    const { client, requests } = fakeGemini([{ text: 'Sure! Let me help you with that.' }, { text: '' }]);
    const result = await runAgentRuntime(runtime(client), input('hi'), stubExecutor({}));
    expect(result).toEqual({ ok: false, reason: 'INVALID_OUTPUT', repaired: true });
    expect(requests).toHaveLength(2);
  });

  it('a Vertex error → RUNTIME_ERROR; a slow model → TIMEOUT, cancelled at the request timeout or the pipeline budget', async () => {
    const failing = fakeGemini([() => Promise.reject(new Error('503 UNAVAILABLE'))]);
    expect(await runAgentRuntime(runtime(failing.client), input('hi'), stubExecutor({}))).toEqual({
      ok: false,
      reason: 'RUNTIME_ERROR',
      repaired: false,
    });

    let aborted = false;
    const hanging: GeminiClient = {
      generate: (_request, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const own = await runAgentRuntime(runtime(hanging, { requestTimeoutMs: 20 }), input('hi'), stubExecutor({}));
    expect(own).toEqual({ ok: false, reason: 'TIMEOUT', repaired: false }); // a slow model is a timeout, not an error
    expect(aborted).toBe(true); // the HTTP request is cancelled, not left running

    const budget = await runAgentRuntime(runtime(hanging), input('hi'), stubExecutor({}), 30);
    expect(budget).toEqual({ ok: false, reason: 'TIMEOUT', repaired: false });
  });

  it('a slow or failing request is tried once more; a request Vertex rejects (4xx) is not', async () => {
    // 1. the first request hangs past the request timeout, the second answers
    let n = 0;
    const flaky: GeminiClient = {
      generate: (_request, signal) =>
        ++n === 1
          ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
          : Promise.resolve({
              functionCalls: [],
              text: proposal(),
              raw: {},
              usage: { promptTokens: 1, outputTokens: 1 },
            }),
    };
    const lines: Record<string, unknown>[] = [];
    const logger = {
      debug() {},
      warn() {},
      error() {},
      info: (_m: string, f?: Record<string, unknown>) => void lines.push(f!),
    };
    const ok = await runAgentRuntime(runtime(flaky, { requestTimeoutMs: 20, logger }), input('hi'), stubExecutor({}));
    expect(ok).toMatchObject({ ok: true, repaired: false });
    expect(lines[0]).toMatchObject({ requests: 1, retries: 1, action: 'NO_ACTION' });

    // 2. a 503 is retried once, then given up
    const unavailable = fakeGemini([() => Promise.reject(Object.assign(new Error('unavailable'), { status: 503 }))]);
    await runAgentRuntime(runtime(unavailable.client), input('hi'), stubExecutor({}));
    expect(unavailable.requests).toHaveLength(2);

    // 3. a 400 / 403 (bad request, no permission) is not retried
    const denied = fakeGemini([() => Promise.reject(Object.assign(new Error('denied'), { status: 403 }))]);
    const result = await runAgentRuntime(runtime(denied.client), input('hi'), stubExecutor({}));
    expect(result).toEqual({ ok: false, reason: 'RUNTIME_ERROR', repaired: false });
    expect(denied.requests).toHaveLength(1);
  });

  it('the decision deadline stops the loop between tool calls', async () => {
    const call = { functionCalls: [{ name: 'get_brand_policy', args: {} }] };
    const { client } = fakeGemini([call]);
    const slowTools = stubExecutor({ get_brand_policy: {} });
    const execute = slowTools.execute.bind(slowTools);
    slowTools.execute = async (c) => {
      await new Promise((r) => setTimeout(r, 30));
      return execute(c);
    };
    const result = await runAgentRuntime(runtime(client, { deadlineMs: 50 }), input('policy?'), slowTools);
    expect(result).toEqual({ ok: false, reason: 'TIMEOUT', repaired: false });
    expect(slowTools.calls.length).toBeLessThan(5);
  });
});

describe('AdkGeminiAgentRuntime — log hygiene', () => {
  it('one line per decision: runtime, model, latency, tool names, token counts, action — never text or references', async () => {
    const lines: { message: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => {},
      warn: () => {},
      error: () => {},
      info: (message: string, fields: Record<string, unknown> = {}) => void lines.push({ message, fields }),
    };
    const { client } = fakeGemini([
      { functionCalls: [{ name: 'find_nearby_stores', args: { variant_id: 'v_min_50', area: 'Bandra West' } }] },
      { text: proposal({ reply_text: 'SECRET-REPLY for the customer', reason: 'SECRET-REASON' }) },
    ]);
    const secretInput = input('SECRET-MESSAGE my number is +91 98765 43210', {
      customer: { channel: 'WHATSAPP', customer_ref: 'wa:••••3210', consent_state: 'OPTED_IN', last_location: null },
    });
    await runtime(client, { logger }).decide(secretInput, stubExecutor({ find_nearby_stores: STORES_OK }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      message: 'agent.gemini_decision',
      fields: {
        runtime: 'ADK_GEMINI',
        model: 'gemini-test-model',
        prompt_version: AGENT_PROMPT_VERSION,
        latency_ms: expect.any(Number),
        requests: 2,
        retries: 0,
        tools: ['find_nearby_stores'],
        prompt_tokens: 200,
        output_tokens: 40,
        action: 'NO_ACTION',
        repair: false,
      },
    });
    expect(JSON.stringify(lines)).not.toMatch(/SECRET|98765|3210|Bandra/);
  });

  it('a failure is logged the same way, with no error text from the model or the customer', async () => {
    const lines: unknown[] = [];
    const logger = { debug() {}, warn() {}, error() {}, info: (m: string, f?: unknown) => void lines.push([m, f]) };
    const { client } = fakeGemini([{ text: 'SECRET not json' }]);
    await runtime(client, { logger }).decide(input('SECRET-MESSAGE'), stubExecutor({}));
    expect(JSON.stringify(lines)).toContain('"action":"INVALID_OUTPUT"');
    expect(JSON.stringify(lines)).not.toContain('SECRET');
  });
});

describe('AdkGeminiAgentRuntime — through the real pipeline', () => {
  it('a store search: the store card is rebuilt from verified tool results, labelled ADK_GEMINI; the hold goes through the guardrail', async () => {
    const { client } = fakeGemini([
      { functionCalls: [{ name: 'find_nearby_stores', args: { variant_id: V1, area: 'Colaba' } }] },
      {
        text: proposal({
          intent_type: 'URGENT_PURCHASE',
          action: 'STORE_DISCOVERY',
          variant_id: V1,
          store_id: 'sc_A',
          reply_text: 'One moment.',
        }),
      },
      {
        text: proposal({
          intent_type: 'URGENT_PURCHASE',
          action: 'STORE_RESERVATION',
          variant_id: V1,
          store_id: 'sc_A',
          reply_text: 'Placing your hold.',
        }),
      },
    ]);
    const s = await buildScenarioWorld({ agent: runtime(client) });
    const found = await s.say('g1', 'I need the Vitamin C Glow Serum 30 ml today near Colaba');
    expect(found.body.decision).toMatchObject({
      action: 'STORE_DISCOVERY',
      runtime: 'ADK_GEMINI',
      decision_source: 'AGENT',
      guardrail_status: 'ALLOWED',
    });
    // The model said "One moment." — the customer gets the verified store card instead.
    expect(found.body.outbound_messages[0].text).toContain('Colaba Store');
    expect(found.body.outbound_messages[0].text).not.toBe('One moment.');
    expect(found.body.outbound_messages[0].options.map((o: { option_id: string }) => o.option_id)).toContain(
      'hold:sc_A',
    );

    const hold = await s.tap('g1', 'hold:sc_A');
    expect(hold.body.decision).toMatchObject({
      action: 'STORE_RESERVATION',
      runtime: 'ADK_GEMINI',
      guardrail_status: 'ALLOWED',
    });
    expect(s.world.reservations.reservations).toHaveLength(1);
    expect(s.world.recommendations.recommendations.every((r) => r.runtime === 'ADK_GEMINI')).toBe(true);
  });

  it('Gemini down → the deterministic fallback answers; no reservation is made', async () => {
    const { client } = fakeGemini([() => Promise.reject(new Error('503'))]);
    const s = await buildScenarioWorld({ agent: runtime(client) });
    const res = await s.startFromStore('g1', 'I need it today');
    expect(res.status).toBe(200);
    // The fallback is the pipeline's own (docs/03 §16.2): a safe reply or a handoff, never a commerce write.
    expect(res.body.decision).toMatchObject({ decision_source: 'DETERMINISTIC_FALLBACK' });
    expect(res.body.outbound_messages[0].text.length).toBeGreaterThan(0);
    expect(s.world.reservations.reservations).toHaveLength(0);
  });

  it('a reservation the model proposes without an offer on the table is blocked by the guardrail', async () => {
    const { client } = fakeGemini([
      { functionCalls: [{ name: 'find_nearby_stores', args: { variant_id: V1, area: 'Colaba' } }] },
      { text: proposal({ action: 'STORE_RESERVATION', variant_id: V1, store_id: 'sc_A', quantity: 1 }) },
    ]);
    const s = await buildScenarioWorld({ agent: runtime(client) });
    const res = await s.say('g1', 'just book it at Colaba');
    expect(res.body.decision).toMatchObject({ action: 'STORE_RESERVATION', guardrail_status: 'BLOCKED' });
    expect(s.world.reservations.reservations).toHaveLength(0);
  });
});

describe('L3: the mock agent is the backup brain behind Gemini (docs/03 §16.2)', () => {
  /** Gemini never answers: every request hangs until it is cancelled. */
  const hangingClient: GeminiClient = {
    generate: (_request, signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  };
  const slowGemini = () => runtime(hangingClient, { requestTimeoutMs: 15, deadlineMs: 60 });
  const failing = (reason: 'throw' | 'invalid'): AgentRuntime => ({
    runtime: 'MOCK',
    async decide() {
      if (reason === 'throw') throw new Error('backup broke');
      return { runtime: 'MOCK', nonsense: true } as never;
    },
  });
  const lastTrace = (s: Awaited<ReturnType<typeof buildScenarioWorld>>) => s.lastRecommendation().trace!;

  it('time is kept for the backup: Gemini stops at 12 s (6.5 s per request, one retry), the backup has 3 s of the 20 s budget', () => {
    expect(GEMINI_DEADLINE_MS).toBe(12_000);
    expect(GEMINI_REQUEST_TIMEOUT_MS).toBe(6_500);
    expect(AI_BACKUP_BUDGET_MS).toBe(3_000);
    expect(GEMINI_DEADLINE_MS + AI_BACKUP_BUDGET_MS).toBeLessThan(AI_DECISION_BUDGET_MS);
  });

  it('only the container picks it: the mock stands behind Gemini; AGENT_RUNTIME=mock has no backup layer', () => {
    const adapters = loadConfig({}).adapters;
    const gemini = createProviders({
      adapters: { ...adapters, agentRuntime: 'adk_gemini' },
      localDataDir: '.d',
      vertex: { project: 'qwikspot-test', model: 'gemini-test-model', location: 'global' },
    });
    expect(gemini.agent.runtime).toBe('ADK_GEMINI');
    expect(gemini.backupAgent?.runtime).toBe('MOCK');
    expect(createProviders({ adapters, localDataDir: '.d' }).backupAgent).toBeUndefined();
  });

  it('Gemini timeout → the mock decides the same message with the same tools: a real store card, traced as AGENT_BACKUP', async () => {
    const s = await buildScenarioWorld({ agent: slowGemini(), backupAgent: new MockAgentRuntime() });
    const res = await s.say('g1', 'I need the Vitamin C Glow Serum 30 ml today near Colaba');
    expect(res.body.decision).toMatchObject({
      action: 'STORE_DISCOVERY',
      runtime: 'MOCK', // the runtime that really decided — never presented as Gemini
      decision_source: 'AGENT_BACKUP',
      guardrail_status: 'ALLOWED',
    });
    expect(res.body.outbound_messages[0].text).toContain('Colaba Store');
    expect(res.body.outbound_messages[0].options.map((o: { option_id: string }) => o.option_id)).toContain('hold:sc_A');
    expect(s.lastRecommendation()).toMatchObject({ runtime: 'MOCK', decisionSource: 'AGENT_BACKUP' });
    expect(lastTrace(s)).toMatchObject({ fallback_reason: 'TIMEOUT' }); // the trace still says Gemini failed
    // The conversation is NOT handed to a person: the next message is answered automatically too.
    expect(s.world.conversations.conversations[0]!.humanHandoff).toBe(false);
    const hold = await s.tap('g1', 'hold:sc_A');
    expect(hold.body.decision).toMatchObject({ action: 'STORE_RESERVATION', decision_source: 'AGENT_BACKUP' });
    expect(s.world.reservations.reservations).toHaveLength(1);
  });

  it('Gemini runtime error → mock backup', async () => {
    const down = fakeGemini([() => Promise.reject(Object.assign(new Error('denied'), { status: 403 }))]);
    const s = await buildScenarioWorld({ agent: runtime(down.client), backupAgent: new MockAgentRuntime() });
    const res = await s.startFromStore('g1', 'Is this good for oily skin?');
    expect(res.body.decision).toMatchObject({ action: 'EDUCATE', runtime: 'MOCK', decision_source: 'AGENT_BACKUP' });
    expect(lastTrace(s)).toMatchObject({ fallback_reason: 'RUNTIME_ERROR' });
  });

  it('output still invalid after the repair attempt → mock backup', async () => {
    const broken = fakeGemini([{ text: 'not json' }]);
    const s = await buildScenarioWorld({ agent: runtime(broken.client), backupAgent: new MockAgentRuntime() });
    const res = await s.say('g1', 'hi');
    expect(broken.requests).toHaveLength(2); // the first attempt and the single repair
    expect(res.body.decision).toMatchObject({ action: 'NO_ACTION', runtime: 'MOCK', decision_source: 'AGENT_BACKUP' });
    expect(res.body.outbound_messages[0].text).toMatch(/^Hi! Welcome to Brand brand_A\./);
    expect(lastTrace(s)).toMatchObject({ fallback_reason: 'INVALID_OUTPUT', repaired: true });
  });

  it('both fail on a timeout → "please try again", NO_ACTION, and no handoff even though handoff is enabled', async () => {
    for (const backup of [failing('throw'), failing('invalid')]) {
      const s = await buildScenarioWorld({ agent: slowGemini(), backupAgent: backup, handoffEnabled: true });
      const res = await s.say('g1', 'I need it today');
      expect(res.body.decision).toMatchObject({
        action: 'NO_ACTION',
        runtime: 'ADK_GEMINI',
        decision_source: 'DETERMINISTIC_FALLBACK',
        executed_action: null,
      });
      expect(res.body.outbound_messages[0].text).toBe(
        'Sorry, something went wrong on our side. Please try again in a moment.',
      );
      expect(lastTrace(s)).toMatchObject({ fallback_reason: 'TIMEOUT' });
      expect(s.world.conversations.conversations[0]!.humanHandoff).toBe(false);
      expect(s.world.reservations.reservations).toHaveLength(0);
    }
  });

  it('a customer who asks for a person is still handed off (that path is a decision, not the fallback)', async () => {
    const s = await buildScenarioWorld({ agent: slowGemini(), backupAgent: new MockAgentRuntime() });
    const res = await s.say('g1', 'I want to talk to a person');
    expect(res.body.decision).toMatchObject({ action: 'HUMAN_HANDOFF', decision_source: 'AGENT_BACKUP' });
    expect(s.world.conversations.conversations[0]!.humanHandoff).toBe(true);
  });

  it('AGENT_RUNTIME=mock is unchanged: no backup layer, the same fallback as before', async () => {
    const slowMock: AgentRuntime = {
      runtime: 'MOCK',
      async decide(i, t) {
        await new Promise((r) => setTimeout(r, 200));
        return new MockAgentRuntime().decide(i, t);
      },
    };
    const s = await buildScenarioWorld({ agent: slowMock, aiBudgetMs: 20 });
    const res = await s.say('c1', 'I need it today');
    expect(res.body.decision).toMatchObject({
      action: 'HUMAN_HANDOFF', // handoff is enabled in this world: exactly today's behaviour
      runtime: 'MOCK',
      decision_source: 'DETERMINISTIC_FALLBACK',
    });
    const ok = await buildScenarioWorld();
    const normal = await ok.startFromStore('c1', 'Is this good for oily skin?');
    expect(normal.body.decision).toMatchObject({ action: 'EDUCATE', runtime: 'MOCK', decision_source: 'AGENT' });
  });

  it('log hygiene: the backup is logged with codes only — no message text, reply or customer reference', async () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));
    const s = await buildScenarioWorld({ agent: slowGemini(), backupAgent: new MockAgentRuntime(), logger });
    await s.say('g1', 'SECRET-TEXT I need the Vitamin C Glow Serum 30 ml today near Colaba, call +91 98765 43210');
    const backup = lines.map((l) => JSON.parse(l)).filter((l) => l.message === 'agent.backup');
    expect(backup).toHaveLength(1);
    expect(backup[0]).toMatchObject({
      severity: 'WARNING',
      brand_id: 'brand_A',
      runtime: 'ADK_GEMINI',
      backup_runtime: 'MOCK',
      failure: 'TIMEOUT',
      outcome: 'BACKUP_DECIDED',
    });
    expect(lines.join('\n')).not.toMatch(/SECRET-TEXT|98765|Colaba Store|Glow Serum/);
  });
});
