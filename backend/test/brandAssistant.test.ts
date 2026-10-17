/**
 * L5 "Ask Qwikspot" — the brand agent. Read-only, this brand only, every number from the data,
 * no shopper identity sent to the model, and an answer within the ceiling: Gemini's when it is
 * fast and grounded, else the rules "Quick summary".
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  FINAL_ROUND_RESERVE_MS,
  GeminiAssistant,
  HEDGE_AFTER_MS,
  HEDGE_MIN_LEFT_MS,
} from '../src/adapters/agent/geminiAssistant.js';
import type { AssistantModel, AssistantRound } from '../src/ports/assistant.js';
import type { GeminiClient, GeminiRequest } from '../src/adapters/agent/geminiClient.js';
import {
  BRAND_ASSISTANT_PROMPT,
  brandToolsFor,
  numbersOf,
  quickAnswer,
  redactPII,
  ungroundedNumbers,
  type BrandAnswer,
  type BrandPack,
} from '../src/domain/brandAssistant.js';
import { ahmedabadWorld } from './ahmedabadWorld.js';
import { answerLogs, FakeAssistantModel } from './fakeAssistant.js';
import { bearer } from './helpers.js';

const FakeBrandModel = FakeAssistantModel;
const logs = () => answerLogs('brand_assistant.answer');

/** The Ahmedabad world with a little activity: a hold, an unmet 50 ml request, a handoff with a phone number. */
async function busyWorld(options: Parameters<typeof ahmedabadWorld>[0] & { assistantDeadlineMs?: number } = {}) {
  const s = await ahmedabadWorld(options);
  await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
  await s.tap('c1', 'hold:st_north_1');
  await s.say('c2', 'I need Vitamin C Glow Serum 50 ml today near Navrangpura');
  await s.say('c3', 'Call me on +91 98765 43210, I want to talk to a person');
  const as = (user = 'admin_a') => ({
    get: (p: string) => request(s.world.app).get(p).set('Authorization', bearer(user)),
    post: (p: string, body: object) => request(s.world.app).post(p).set('Authorization', bearer(user)).send(body),
  });
  const conversationOf = (ref: string) => {
    const customer = s.world.customers.customers.find((c) => c.displayRef.endsWith(ref))!;
    return s.world.conversations.conversations.find((c) => c.customerId === customer.customerId)!.conversationId;
  };
  return { ...s, as, conversationOf };
}

describe('the grounding rules (pure)', () => {
  it('a number the data does not contain is caught; dates and ids are never a source of numbers', () => {
    const data = { holds: 3, text: 'requested 4 times', at: '2026-10-14T06:30:00.000Z', id: 'st_north_1' };
    expect(ungroundedNumbers('3 holds; asked 4 times', data)).toEqual([]);
    expect(ungroundedNumbers('3 holds, 75% filled', data)).toEqual([75]);
    expect(ungroundedNumbers('opened in 2026', data)).toEqual([2026]);
    expect([...numbersOf(data)].sort()).toEqual([3, 4]);
  });

  it('phone numbers, emails and pickup codes are redacted before the model sees a message', () => {
    expect(redactPII('call +91 98765 43210 or a@b.co, code 204733')).toBe('call [phone] or [email], code [code]');
    expect(redactPII('Hi, my name is Priya Shah and I need it today')).toBe(
      'Hi, my name is [name] and I need it today',
    );
    expect(redactPII('mera naam Priya hai')).toBe('mera naam [name] hai');
    expect(redactPII("I'm in Satellite")).toBe("I'm in Satellite"); // an area is not a name
  });
});

describe('Ask Qwikspot — the drawer (POST /api/brand/assistant/ask)', () => {
  it('without Gemini: a "Quick summary" from the pack, for the page and question', async () => {
    const s = await busyWorld();
    const res = await s
      .as()
      .post('/api/brand/assistant/ask', { question: 'Which holds are at risk?', page: 'RESERVATIONS' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'QUICK_SUMMARY',
      next_action: { page: 'RESERVATIONS', path: '/brand/reservations' },
    });
    expect(res.body.answer).toMatch(/^1 hold is active; 1 is waiting for the store to confirm/);
  });

  it('Gemini answers with numbers from the pack → the AI answer, with the page link', async () => {
    const model = new FakeBrandModel((input) => {
      const pack = input.data as BrandPack;
      return {
        answer: `${pack.holds_now.waiting_for_store} hold is waiting on Wellness Mart. Ask the store to confirm it.`,
        next_action: { label: 'Open reservations', page: 'RESERVATIONS' },
        used: ['holds_now'],
      };
    });
    const s = await busyWorld({ assistantModel: model });
    const res = await s
      .as()
      .post('/api/brand/assistant/ask', { question: 'What should I fix first?', page: 'OVERVIEW' });
    expect(res.body).toMatchObject({
      source: 'AI',
      answer: '1 hold is waiting on Wellness Mart. Ask the store to confirm it.',
      next_action: { label: 'Open reservations', page: 'RESERVATIONS', path: '/brand/reservations' },
    });
    expect(model.inputs[0]).toMatchObject({ task: 'ANSWER', page: 'OVERVIEW', question: 'What should I fix first?' });
  });

  it('the pack sent to Gemini holds no shopper: no customer ref, no phone number, no pickup code', async () => {
    const model = new FakeBrandModel(() => ({ answer: 'All good.' }));
    const s = await busyWorld({ assistantModel: model });
    await s.as().post('/api/brand/assistant/ask', { question: 'How did we do this week?', page: 'OVERVIEW' });
    const sent = JSON.stringify(model.inputs[0]);
    const pickupCode = s.world.reservations.reservations[0]!.pickupCode;
    expect(sent).not.toMatch(/sim:c\d|98765|customer_ref|customerId/);
    expect(sent).not.toContain(pickupCode);
    expect(sent).toContain('Wellness Mart');
  });

  it.each([
    ['a number not in the data', { answer: 'Holds are up 40% this week.' }, 'UNGROUNDED'],
    ['a phone number', { answer: 'Call the shopper on +91 98765 43210.' }, 'PII'],
  ] as const)('Gemini writes %s → the Quick summary instead, and the reason is logged', async (_c, answer, failure) => {
    const log = logs();
    const s = await busyWorld({ assistantModel: new FakeBrandModel(() => answer), logger: log.logger });
    const res = await s.as().post('/api/brand/assistant/ask', { question: 'How did we do?', page: 'OVERVIEW' });
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(res.body.answer).not.toContain(answer.answer);
    expect(log.answers().at(-1)!.fields).toMatchObject({ surface: 'ASK', source: 'QUICK_SUMMARY', failure });
    expect(JSON.stringify(log.answers())).not.toContain(answer.answer); // reason codes only, never the text
  });

  it('Gemini too slow → the Quick summary arrives at the deadline (timeout logged); Gemini failing → the same', async () => {
    const log = logs();
    const slow = new FakeBrandModel(
      () => new Promise<BrandAnswer>((r) => setTimeout(() => r({ answer: 'late' }), 2_000)),
    );
    const s = await busyWorld({ assistantModel: slow, assistantDeadlineMs: 50, logger: log.logger });
    const started = Date.now();
    const res = await s.as().post('/api/brand/assistant/ask', { question: 'How did we do?', page: 'OVERVIEW' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(log.answers().at(-1)!.fields).toMatchObject({ failure: 'TIMEOUT' });

    const broken = await busyWorld({
      assistantModel: new FakeBrandModel(() => {
        throw new Error('503');
      }),
      logger: log.logger,
    });
    const res2 = await broken.as().post('/api/brand/assistant/ask', { question: 'How did we do?', page: 'OVERVIEW' });
    expect(res2.body.source).toBe('QUICK_SUMMARY');
    expect(log.answers().at(-1)!.fields).toMatchObject({ failure: 'ERROR' });
  });

  it('only a Brand Admin, only its own brand; a question must be 2–300 characters; 20 a minute', async () => {
    const s = await busyWorld();
    expect((await s.as('radmin_A').post('/api/brand/assistant/ask', { question: 'hi there' })).status).toBe(403);
    expect((await s.as('platform').post('/api/brand/assistant/ask', { question: 'hi there' })).status).toBe(403);
    expect((await s.as().post('/api/brand/assistant/ask', { question: 'x' })).status).toBe(400);
    expect((await s.as().post('/api/brand/assistant/ask', { question: 'ok?', page: 'NOWHERE' })).status).toBe(400);
    for (let i = 0; i < 20; i++) await s.as().post('/api/brand/assistant/ask', { question: 'How did we do?' });
    const limited = await s.as().post('/api/brand/assistant/ask', { question: 'How did we do?' });
    expect([limited.status, limited.body.error.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('the Gemini adapter: one call with the pack, at most 2 tool rounds', () => {
  it('calls get_store, then answers with a number from the tool result — accepted; a third round gets no tools', async () => {
    const requests: GeminiRequest[] = [];
    const answer = (text: string) => ({
      functionCalls: [],
      text: JSON.stringify({ answer: text, next_action: null, used: ['stores'] }),
      raw: {},
      usage: { promptTokens: 1, outputTokens: 1 },
    });
    let n = 0;
    const client: GeminiClient = {
      async generate(req) {
        requests.push(req);
        n++;
        if (n <= 2)
          return {
            functionCalls: [{ name: 'get_store', args: { store_id: 'st_north_1' } }],
            text: null,
            raw: {},
            usage: { promptTokens: 1, outputTokens: 1 },
          };
        return answer('Wellness Mart has 1 hold waiting; it was created 0 minutes ago.');
      },
    };
    const model = new GeminiAssistant({ client, model: 'gemini-test' });
    const s = await busyWorld({ assistantModel: model });
    const res = await s
      .as()
      .post('/api/brand/assistant/ask', { question: 'What holds does Wellness Mart have right now?', page: 'NETWORK' });
    expect(res.body.source).toBe('AI');
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.tools.map((t) => t.name))).toEqual([['get_store'], ['get_store'], []]); // the third must answer
    // JSON mode only on the round with no tools (Vertex may reject JSON mode with function calling).
    expect(requests.map((r) => r.responseSchema !== null)).toEqual([false, false, true]);
    expect(requests[0]!.system).toMatch(/Every number you write must appear in the data or a tool result/);
  });
});

describe('L8: one Gemini call when the pack covers the question', () => {
  const recording = () => {
    const requests: GeminiRequest[] = [];
    const client: GeminiClient = {
      async generate(req) {
        requests.push(req);
        return {
          functionCalls: [],
          text: JSON.stringify({ answer: 'Wellness Mart has 1 hold waiting.', next_action: null, used: ['holds_now'] }),
          raw: {},
          usage: { promptTokens: 1, outputTokens: 1 },
        };
      },
    };
    return { requests, model: new GeminiAssistant({ client, model: 'gemini-test' }) };
  };

  it.each([
    ['OVERVIEW', 'How did we do this week?'],
    ['OVERVIEW', 'What should I fix first?'],
    ['CONVERSATIONS', 'Why did chats end without a hold this week?'],
    ['RESERVATIONS', 'Which holds are at risk?'],
    ['RESERVATIONS', 'Which store is slowest to accept?'],
    ['RESERVATIONS', 'Which store is slowest to accept holds?'],
    ['INSIGHTS', 'Compare Satellite and Navrangpura'],
    ['NETWORK', 'Which store needs attention?'],
    ['SETTINGS', 'What does Qwikspot do automatically for me?'],
  ])('%s "%s": exactly one Gemini call, no tools, JSON mode', async (page, question) => {
    const { requests, model } = recording();
    const s = await busyWorld({ assistantModel: model });
    const res = await s.as().post('/api/brand/assistant/ask', { question, page });
    expect(res.body.source).toBe('AI');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toEqual([]);
    expect(requests[0]!.responseSchema).not.toBeNull();
  });

  it('the Overview brief is one call with no tools', async () => {
    const { requests, model } = recording();
    const s = await busyWorld({ assistantModel: model });
    await s.as().get('/api/brand/assistant/brief?refresh=true');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toEqual([]);
  });

  it("tools only for what the pack does not hold: particular chats, one named store's holds", () => {
    const pack = { stores: [{ name: 'Wellness Mart' }, { name: 'HealthPlus Chemist' }] } as unknown as BrandPack;
    expect(brandToolsFor('Show me chats where the shopper refused a store', pack)).toEqual(['list_conversations']);
    expect(brandToolsFor('Which conversations went to a person?', pack)).toEqual(['list_conversations']);
    expect(brandToolsFor('What holds does HealthPlus Chemist have?', pack)).toEqual(['get_store']);
    expect(brandToolsFor('How many chats did we get this week?', pack)).toEqual([]);
    expect(brandToolsFor('Which holds are at risk?', pack)).toEqual([]);
    expect(brandToolsFor('Which store needs attention?', pack)).toEqual([]);
  });

  it('the pack has each store\'s oldest waiting hold ("slowest to accept" needs no tool)', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await busyWorld({ assistantModel: model });
    await s
      .as()
      .post('/api/brand/assistant/ask', { question: 'Which store is slowest to accept?', page: 'RESERVATIONS' });
    const pack = model.inputs.at(-1)!.data as BrandPack;
    expect(pack.holds_now.by_store).toContainEqual(
      expect.objectContaining({ store: 'Wellness Mart', waiting: 1, oldest_waiting_minutes: 0 }),
    );
  });

  it('"0 holds expire within 60 minutes" is grounded: the window is in the pack; an invented number is still rejected', async () => {
    const answers = [
      'There are 0 holds expiring within 60 minutes; 1 is waiting at Wellness Mart.',
      'There are 0 holds expiring within 45 minutes.',
    ];
    const sources: string[] = [];
    for (const text of answers) {
      const s = await busyWorld({ assistantModel: new FakeAssistantModel(() => ({ answer: text })) });
      const res = await s
        .as()
        .post('/api/brand/assistant/ask', { question: 'Which holds are at risk?', page: 'RESERVATIONS' });
      sources.push(res.body.source);
    }
    expect(sources).toEqual(['AI', 'QUICK_SUMMARY']);
  });

  it('a stalled request is sent once more after the hedge delay; the first answer wins, the other is cancelled', async () => {
    expect([HEDGE_AFTER_MS, HEDGE_MIN_LEFT_MS]).toEqual([7_000, 6_000]);
    const run = async (finishInMs: number) => {
      const signals: AbortSignal[] = [];
      const client: GeminiClient = {
        generate(_req, signal) {
          signals.push(signal);
          if (signals.length === 1) return new Promise<never>(() => undefined); // Vertex never answers
          return Promise.resolve({
            functionCalls: [],
            text: '{"answer":"ok"}',
            raw: {},
            usage: { promptTokens: 1, outputTokens: 1 },
          });
        },
      };
      const model = new GeminiAssistant({ client, model: 'gemini-test', hedgeAfterMs: 20 });
      const request = {
        prompt: 'p',
        promptVersion: 'v',
        answerSchema: {},
        task: 'ANSWER' as const,
        page: 'OVERVIEW',
        data: {},
        tools: [],
      };
      const trace = { rounds: [] as AssistantRound[] };
      const controller = new AbortController();
      const outcome = await Promise.race([
        model
          .generate({ ...request, finishBy: Date.now() + finishInMs }, async () => ({}), controller.signal, trace)
          .then(() => 'answered'),
        new Promise((r) => setTimeout(() => r('still waiting'), 300)),
      ]);
      controller.abort();
      return {
        outcome,
        requests: signals.length,
        firstCancelled: signals[0]!.aborted,
        hedged: trace.rounds[0]?.hedged,
      };
    };
    expect(await run(15_000)).toEqual({ outcome: 'answered', requests: 2, firstCancelled: true, hedged: true });
    // Less than 6 s left: a second request could not answer in time, so none is sent.
    expect(await run(5_000)).toMatchObject({ outcome: 'still waiting', requests: 1 });
  });

  it('a 429 is retried once when an answer round still fits; not when it does not', async () => {
    const run = async (finishInMs: number) => {
      let calls = 0;
      const client: GeminiClient = {
        async generate() {
          calls++;
          if (calls === 1) throw Object.assign(new Error('Resource exhausted'), { status: 429 });
          return { functionCalls: [], text: '{"answer":"ok"}', raw: {}, usage: { promptTokens: 1, outputTokens: 1 } };
        },
      };
      const model = new GeminiAssistant({ client, model: 'gemini-test' });
      const request = {
        prompt: 'p',
        promptVersion: 'v',
        answerSchema: {},
        task: 'ANSWER' as const,
        page: 'OVERVIEW',
        data: {},
        tools: [],
      };
      const result = await model
        .generate({ ...request, finishBy: Date.now() + finishInMs }, async () => ({}), new AbortController().signal)
        .then(
          () => 'answered',
          (err: { status?: number }) => `failed ${err.status}`,
        );
      return { result, calls };
    };
    expect(await run(15_000)).toEqual({ result: 'answered', calls: 2 });
    expect(await run(5_000)).toEqual({ result: 'failed 429', calls: 1 });
  });

  it('no tool round is started that would leave the answer round less than 8 s before the deadline', async () => {
    expect(FINAL_ROUND_RESERVE_MS).toBe(8_000);
    const requests: GeminiRequest[] = [];
    const client: GeminiClient = {
      async generate(req) {
        requests.push(req);
        return { functionCalls: [], text: '{"answer":"ok"}', raw: {}, usage: { promptTokens: 1, outputTokens: 1 } };
      },
    };
    const model = new GeminiAssistant({ client, model: 'gemini-test' });
    const tool = { name: 'get_store', description: 'd', parameters: { type: 'object' } };
    const base = {
      prompt: 'p',
      promptVersion: 'v',
      answerSchema: {},
      task: 'ANSWER' as const,
      page: 'NETWORK',
      data: {},
    };
    const signal = new AbortController().signal;
    await model.generate({ ...base, tools: [tool], finishBy: Date.now() + 7_000 }, async () => ({}), signal);
    await model.generate({ ...base, tools: [tool], finishBy: Date.now() + 15_000 }, async () => ({}), signal);
    expect(requests.map((r) => r.tools.length)).toEqual([0, 1]);
  });
});

describe('the Overview brief (GET /api/brand/assistant/brief)', () => {
  it('a quick brief without Gemini: the period, the biggest problem and one next action', async () => {
    const s = await busyWorld();
    const res = await s.as().get('/api/brand/assistant/brief');
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(res.body.answer).toMatch(/^In the last 7 days: /);
    expect(res.body.answer).toMatch(
      /Biggest problem: .+ 50 ml was asked for 1 time in Navrangpura with no store in stock\./,
    );
    expect(res.body.next_action).toMatchObject({ page: 'RESERVATIONS' });
  });

  it('written once and reused for 10 minutes; refresh=true writes it again', async () => {
    const model = new FakeBrandModel(() => ({
      answer: 'A quiet week with 1 hold.',
      next_action: { label: 'See insights', page: 'INSIGHTS' },
    }));
    const s = await busyWorld({ assistantModel: model });
    const first = await s.as().get('/api/brand/assistant/brief');
    const second = await s.as().get('/api/brand/assistant/brief');
    expect(first.body).toMatchObject({ source: 'AI', answer: 'A quiet week with 1 hold.' });
    expect(second.body.generated_at).toBe(first.body.generated_at);
    expect(model.inputs.filter((i) => i.task === 'BRIEF')).toHaveLength(1);
    await s.as().get('/api/brand/assistant/brief?refresh=true');
    expect(model.inputs.filter((i) => i.task === 'BRIEF')).toHaveLength(2);
  });
});

describe('the conversation summary (GET /api/brand/conversations/:id/summary)', () => {
  it('without Gemini: what the shopper wanted and what happened; a handoff brief for a handed-off chat', async () => {
    const s = await busyWorld();
    const held = await s.as().get(`/api/brand/conversations/${s.conversationOf('c1')}/summary`);
    expect(held.body).toMatchObject({ source: 'QUICK_SUMMARY', handoff_brief: null });
    expect(held.body.answer).toMatch(
      /^The shopper wanted Vitamin C Glow Serum 30 ml; a hold at Wellness Mart is pending\./,
    );
    const handoff = await s.as().get(`/api/brand/conversations/${s.conversationOf('c3')}/summary`);
    expect(handoff.body.handoff_brief).toMatch(/^They asked for a person after \d+ messages\./);
  });

  it('Gemini: the transcript it gets is redacted; the summary is stored and reused until a new message', async () => {
    const model = new FakeBrandModel((input) =>
      input.task === 'SUMMARY'
        ? { answer: 'The shopper wanted to talk to a person.', handoff_brief: 'They want a call back; no hold.' }
        : { answer: 'ok' },
    );
    const s = await busyWorld({ assistantModel: model });
    const id = s.conversationOf('c3');
    const first = await s.as().get(`/api/brand/conversations/${id}/summary`);
    expect(first.body).toMatchObject({
      source: 'AI',
      answer: 'The shopper wanted to talk to a person.',
      handoff_brief: 'They want a call back; no hold.',
    });
    expect(JSON.stringify(model.inputs[0]!.data)).toContain('[phone]');
    expect(JSON.stringify(model.inputs[0]!.data)).not.toContain('98765');
    await s.as().get(`/api/brand/conversations/${id}/summary`);
    expect(model.inputs).toHaveLength(1); // stored
    await s.as().post(`/api/brand/conversations/${id}/replies`, { text: 'Hello, this is the team.' });
    await s.as().get(`/api/brand/conversations/${id}/summary`);
    expect(model.inputs).toHaveLength(2); // a new message → written again
  });

  it("another brand's conversation is 404", async () => {
    const s = await busyWorld();
    const res = await s.as('admin_b').get(`/api/brand/conversations/${s.conversationOf('c1')}/summary`);
    expect(res.status).toBe(404);
  });
});

describe('the pack is about what the page shows: its period and the synthetic-history switch', () => {
  /** What the Overview tiles show (frontend overview.ts kpis), from the same insights endpoint. */
  const tiles = (f: {
    intents: number;
    conversations: number;
    reservations: number;
    completed: number;
    outcomes: Record<string, number>;
    value: { amount: number };
  }) => {
    const online = f.outcomes.ONLINE! + f.outcomes.ALTERNATIVE!;
    const purchases = f.outcomes.OFFLINE! + online;
    const finished = purchases + f.outcomes.NONE!;
    return {
      shopper_intents: f.intents,
      new_conversations: f.conversations,
      holds: f.reservations,
      pickups_collected_in_store: f.completed,
      online_orders: online,
      purchases,
      finished_journeys: finished,
      conversion_percent: finished === 0 ? null : Math.round((purchases / finished) * 100),
      value_of_purchases: f.value.amount,
    };
  };

  it('with history hidden: live records only, the totals equal the tiles, and the Quick brief says so', async () => {
    const model = new FakeBrandModel(() => ({ answer: 'ok' }));
    const s = await busyWorld({ assistantModel: model });
    // c1's conversation and hold become synthetic demo history.
    const c1 = s.conversationOf('c1');
    const conversation = s.world.conversations.conversations.find((c) => c.conversationId === c1)!;
    conversation.demoHistory = true;
    for (const r of s.world.reservations.reservations)
      if (r.customerId === conversation.customerId) r.demoHistory = true;

    for (const [days, include] of [
      [7, true],
      [7, false],
      [28, false],
    ] as const) {
      await s.as().post('/api/brand/assistant/ask', {
        question: 'How did we do?',
        page: 'OVERVIEW',
        days,
        include_history: include,
      });
      const pack = model.inputs.at(-1)!.data as BrandPack;
      const insights = await s.as().get(`/api/brand/insights?days=${days}&include_history=${include}`);
      expect(pack).toMatchObject({ period_days: days, synthetic_history_included: include });
      expect(pack.totals, `${days} days, history ${include}`).toMatchObject(tiles(insights.body.funnel));
      expect(pack.holds_now.active).toBe(include ? 1 : 0);
      expect(pack.conversations_now.total).toBe(include ? 3 : 2);
    }

    const quick = await busyWorld();
    const live = await quick.as().get('/api/brand/assistant/brief?days=7&include_history=false');
    expect(live.body.answer).toMatch(/^In the last 7 days \(live activity only\): /);
  });

  it('a brief is cached per period and switch, not one per brand', async () => {
    const model = new FakeBrandModel(() => ({ answer: 'A brief.' }));
    const s = await busyWorld({ assistantModel: model });
    await s.as().get('/api/brand/assistant/brief?days=7&include_history=true');
    await s.as().get('/api/brand/assistant/brief?days=7&include_history=false');
    await s.as().get('/api/brand/assistant/brief?days=28&include_history=false');
    await s.as().get('/api/brand/assistant/brief?days=7&include_history=false');
    expect(
      model.inputs
        .filter((i) => i.task === 'BRIEF')
        .map((i) => [(i.data as BrandPack).period_days, (i.data as BrandPack).synthetic_history_included]),
    ).toEqual([
      [7, true],
      [7, false],
      [28, false],
    ]);
    expect((await s.as().get('/api/brand/assistant/brief?days=14')).status).toBe(400);
  });
});

describe('quick answers follow the page', () => {
  const pack: BrandPack = {
    brand_name: 'Demo',
    period_days: 7,
    synthetic_history_included: true,
    totals: {
      shopper_intents: 5,
      new_conversations: 4,
      store_recommendations: 3,
      holds: 2,
      pickups_collected_in_store: 1,
      online_orders: 0,
      purchases: 1,
      finished_journeys: 1,
      conversion_percent: 100,
      journeys_without_purchase: 0,
      pickups_not_in_conversion: 0,
      value_of_purchases: 795,
      currency: 'INR',
    },
    stores: [
      {
        store_id: 'st_1',
        name: 'GlowUp Beauty',
        area: 'Satellite',
        status: 'ACTIVE',
        has_store_admin: false,
        sku_count: 12,
        stock_age_hours: 30,
        nearest_lookups: 4,
        had_stock: 1,
        fill_rate_percent: 25,
        refusals: 1,
        holds_confirmed: 0,
        median_minutes_to_confirm: null,
      },
    ],
    stores_count: 1,
    unmet_demand: [{ product: 'Vitamin C Glow Serum 50 ml', area: 'Navrangpura', count: 6 }],
    weekday_reading: null,
    suggestions: [],
    holds_now: {
      active: 0,
      waiting_for_store: 0,
      oldest_waiting_minutes: null,
      expiry_window_minutes: 60,
      expiring_within_60_min: 0,
      by_store: [],
    },
    conversations_now: { total: 4, with_hold: 2, without_hold: 2, refused_by_store: 1, with_person: 0 },
  };
  it('Network: the weakest store, stale stock, missing Store Admins', () => {
    expect(quickAnswer('Which store needs attention?', 'NETWORK', pack).answer).toBe(
      'GlowUp Beauty had stock for 1 of the 4 shoppers it was nearest to (25%). Stock data is more than a day old at GlowUp Beauty. 1 store has no Store Admin yet.',
    );
  });
  it('Insights: the product losing the most demand', () => {
    expect(quickAnswer('Which product is losing the most demand?', 'INSIGHTS', pack).answer).toMatch(
      /^Vitamin C Glow Serum 50 ml was asked for 6 times in Navrangpura with no store in stock\./,
    );
  });
});

describe('the ASSISTANT_QUESTION event (brand)', () => {
  it('a question is recorded with the page and who answered — never its text; a brief is not a question', async () => {
    const s = await busyWorld();
    await s.as().post('/api/brand/assistant/ask', { question: 'Which holds are at risk?', page: 'RESERVATIONS' });
    await s.as().get('/api/brand/assistant/brief');
    const events = s.world.events.events.filter((e) => e.eventType === 'ASSISTANT_QUESTION');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityReference: null,
      payload: { console: 'BRAND', page: 'RESERVATIONS', source: 'QUICK_SUMMARY' },
    });
    expect(JSON.stringify(events[0])).not.toContain('at risk');
  });
});

describe('L8 answers: a particular chat, accept times, empty values, percentages, conversion', () => {
  it.each([
    'Why did the last chat end without a hold?',
    'How did the latest conversation go?',
    'What happened in that chat?',
    'Why did the chat with the serum shopper end?',
    'Show me recent chats',
    'Aakhri chat hold ke bina kyun khatam hui?',
    'Kaunsi chat mein hold nahi bana?',
  ])('"%s" is offered list_conversations', (question) => {
    expect(brandToolsFor(question, { stores: [] } as unknown as BrandPack)).toEqual(['list_conversations']);
  });

  it.each([
    'Why did chats end without a hold this week?',
    'Which store is slowest to accept holds?',
    'How many chats did we get this week?',
  ])('"%s" is covered by the pack: no tool', (question) => {
    expect(brandToolsFor(question, { stores: [] } as unknown as BrandPack)).toEqual([]);
  });

  it('"Why did the last chat end without a hold?": the tool gives the latest chat first, with its decisions and holds', async () => {
    let output: unknown;
    let offered: string[] = [];
    const model: AssistantModel = {
      model: 'tool-caller',
      async generate(request, runTool) {
        offered = request.tools.map((t) => t.name);
        output = await runTool('list_conversations', { without_hold: true, limit: 3 });
        return { raw: { answer: 'ok' }, toolOutputs: [output], toolCalls: ['list_conversations'] };
      },
    };
    const s = await busyWorld({ assistantModel: model });
    // c3 (the handoff) spoke last; c2 (unmet 50 ml) before it; c1 has a hold.
    const at = { c1: '2026-10-14T06:00:00.000Z', c2: '2026-10-14T06:10:00.000Z', c3: '2026-10-14T06:20:00.000Z' };
    for (const [ref, iso] of Object.entries(at))
      s.world.conversations.conversations.find((c) => c.conversationId === s.conversationOf(ref))!.lastMessageAt = iso;
    await s.as().post('/api/brand/assistant/ask', {
      question: 'Why did the last chat end without a hold?',
      page: 'CONVERSATIONS',
    });
    expect(offered).toEqual(['list_conversations']);
    const rows = output as {
      conversation_id: string;
      had_hold: boolean;
      decisions: unknown[];
      holds: unknown[];
      last_activity_at: string;
    }[];
    expect(rows.map((r) => r.conversation_id)).toEqual([s.conversationOf('c3'), s.conversationOf('c2')]);
    expect(rows.every((r) => !r.had_hold && Array.isArray(r.decisions) && Array.isArray(r.holds))).toBe(true);
    expect(rows[1]!.decisions.length).toBeGreaterThan(0); // the 50 ml lookup's decision trace
    expect(JSON.stringify(output)).not.toMatch(/98765|sim:c\d|customer_id/);
  });

  it('the tool keeps to the period: a chat older than 7 days is not "the last chat"', async () => {
    let output: unknown;
    const model: AssistantModel = {
      model: 'tool-caller',
      async generate(_request, runTool) {
        output = await runTool('list_conversations', { without_hold: true });
        return { raw: { answer: 'ok' }, toolOutputs: [output], toolCalls: [] };
      },
    };
    const s = await busyWorld({ assistantModel: model });
    for (const c of s.world.conversations.conversations) c.lastMessageAt = '2026-10-01T06:00:00.000Z';
    await s.as().post('/api/brand/assistant/ask', { question: 'Why did the last chat end without a hold?' });
    expect(output).toEqual([]);
    expect(BRAND_ASSISTANT_PROMPT).toMatch(/say plainly that no chat matched in this period/);
  });

  it('nothing waiting: "No holds are waiting right now, so no store is behind." — and the slowest median confirm time', () => {
    const pack = {
      period_days: 7,
      holds_now: { active: 0, waiting_for_store: 0, oldest_waiting_minutes: null, by_store: [] },
      stores: [
        { name: 'Wellness Mart', holds_confirmed: 3, median_minutes_to_confirm: 4 },
        { name: 'HealthPlus Chemist', holds_confirmed: 2, median_minutes_to_confirm: 18 },
        { name: 'Skin Studio', holds_confirmed: 0, median_minutes_to_confirm: null },
      ],
      unmet_demand: [],
      suggestions: [],
      totals: {},
      conversations_now: {},
    } as unknown as BrandPack;
    expect(quickAnswer('Which store is slowest to accept holds?', 'RESERVATIONS', pack).answer).toBe(
      'No holds are waiting right now, so no store is behind. In the last 7 days the slowest to confirm was HealthPlus Chemist: a median of 18 min over 2 holds.',
    );
    const none = { ...pack, stores: [] } as BrandPack;
    expect(quickAnswer('Which store is slowest to accept holds?', 'RESERVATIONS', none).answer).toBe(
      'No holds are waiting right now, so no store is behind. No store confirmed a hold in the last 7 days.',
    );
    expect(BRAND_ASSISTANT_PROMPT).toMatch(/No holds are waiting right now, so no store is behind\./);
    expect(BRAND_ASSISTANT_PROMPT).toMatch(/Never say the data "doesn't track"/);
  });

  it("each store's median minutes to confirm, for the period and the synthetic-history choice", async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await busyWorld({ assistantModel: model });
    const holds = s.world.reservations.reservations.filter((r) => r.storeId === 'st_north_1');
    const base = Date.parse('2026-10-14T06:30:00.000Z');
    const set = (r: (typeof holds)[number], createdMinAgo: number, confirmAfter: number, demo = false) => {
      r.createdAt = new Date(base - createdMinAgo * 60_000).toISOString();
      r.confirmedAt = new Date(base - createdMinAgo * 60_000 + confirmAfter * 60_000).toISOString();
      r.demoHistory = demo;
    };
    set(holds[0]!, 60, 12);
    const store = async (days: 7 | 28, include: boolean) => {
      await s.as().post('/api/brand/assistant/ask', {
        question: 'Which store is slowest to accept holds?',
        days,
        include_history: include,
      });
      return (model.inputs.at(-1)!.data as BrandPack).stores.find((x) => x.name === 'Wellness Mart')!;
    };
    expect(await store(7, true)).toMatchObject({ holds_confirmed: 1, median_minutes_to_confirm: 12 });
    // Synthetic history hidden → that hold drops out.
    holds[0]!.demoHistory = true;
    expect(await store(7, false)).toMatchObject({ holds_confirmed: 0, median_minutes_to_confirm: null });
    // Created 10 days ago: outside 7 days, inside 28.
    set(holds[0]!, 10 * 24 * 60, 30);
    expect(await store(7, true)).toMatchObject({ holds_confirmed: 0, median_minutes_to_confirm: null });
    expect(await store(28, true)).toMatchObject({ holds_confirmed: 1, median_minutes_to_confirm: 30 });
  });

  it('percentages with % pass the number checker: "100% fill rate", "conversion 0%"; an invented one does not', async () => {
    const run = async (answer: string) => {
      const s = await busyWorld({ assistantModel: new FakeAssistantModel(() => ({ answer })) });
      return (
        await s.as().post('/api/brand/assistant/ask', { question: 'Which store needs attention?', page: 'NETWORK' })
      ).body.source;
    };
    expect(await run('Wellness Mart has a 100% fill rate, and conversion is 0% so far.')).toBe('AI');
    expect(await run('Wellness Mart has a 87% fill rate.')).toBe('QUICK_SUMMARY');
    expect(BRAND_ASSISTANT_PROMPT).toMatch(/"100% fill rate", "conversion 0%"/);
  });

  it("conversion is the Overview tile's: a collected pickup is a purchase; a pickup it does not count is explained", async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await busyWorld({ assistantModel: model });
    const tile = (await s.as().get('/api/brand/insights?days=7&include_history=true')).body.funnel;
    await s.as().post('/api/brand/assistant/ask', { question: 'What is our conversion?' });
    const t = (model.inputs.at(-1)!.data as BrandPack).totals;
    const purchases = tile.outcomes.OFFLINE + tile.outcomes.ONLINE + tile.outcomes.ALTERNATIVE;
    expect(t).toMatchObject({
      purchases,
      finished_journeys: purchases + tile.outcomes.NONE,
      pickups_not_in_conversion: Math.max(0, tile.completed - tile.outcomes.OFFLINE - tile.outcomes.ALTERNATIVE),
    });

    const pack = {
      totals: { conversion_percent: 0, purchases: 0, finished_journeys: 1, pickups_not_in_conversion: 1 },
      holds_now: { by_store: [] },
      stores: [],
      unmet_demand: [],
      suggestions: [],
      conversations_now: {},
    } as unknown as BrandPack;
    expect(quickAnswer('Why is conversion 0 with a pickup?', 'OVERVIEW', pack).answer).toMatch(
      /^Conversion is 0%: 0 of 1 finished journey ended in a purchase\. 1 pickup belongs to a journey that had already closed without a purchase or finished outside the period, so conversion does not count it\./,
    );
  });
});
