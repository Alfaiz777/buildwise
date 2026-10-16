/**
 * L5 "Ask Qwikspot" — the brand agent. Read-only, this brand only, every number from the data,
 * no shopper identity sent to the model, and an answer within the ceiling: Gemini's when it is
 * fast and grounded, else the rules "Quick summary".
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { GeminiBrandAssistant } from '../src/adapters/agent/geminiBrandAssistant.js';
import type { GeminiClient, GeminiRequest } from '../src/adapters/agent/geminiClient.js';
import {
  numbersOf,
  quickAnswer,
  redactPII,
  ungroundedNumbers,
  type BrandAnswer,
  type BrandPack,
} from '../src/domain/brandAssistant.js';
import type { Logger } from '../src/lib/logger.js';
import type { BrandAssistantModel, BrandModelInput, BrandModelTools } from '../src/ports/brandAssistant.js';
import { ahmedabadWorld } from './ahmedabadWorld.js';
import { bearer } from './helpers.js';

/** A fake brand model: answers what `reply` returns for the input it was given, counting calls. */
class FakeBrandModel implements BrandAssistantModel {
  readonly model = 'fake-brand-model';
  inputs: BrandModelInput[] = [];
  constructor(
    private readonly reply: (input: BrandModelInput, tools: BrandModelTools) => Promise<BrandAnswer> | BrandAnswer,
  ) {}
  async generate(input: BrandModelInput, tools: BrandModelTools, signal: AbortSignal) {
    this.inputs.push(input);
    const answer = await this.reply(input, tools);
    if (signal.aborted) throw new Error('aborted');
    return { answer, toolOutputs: [], toolCalls: [] };
  }
}

const logs = () => {
  const lines: { message: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info: (message, fields) => lines.push({ message, fields: fields ?? {} }),
  };
  return { lines, logger, answers: () => lines.filter((l) => l.message === 'brand_assistant.answer') };
};

/** The Ahmedabad world with a little activity: a hold, an unmet 50 ml request, a handoff with a phone number. */
async function busyWorld(options: Parameters<typeof ahmedabadWorld>[0] & { brandDeadlineMs?: number } = {}) {
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
    const s = await busyWorld({ brandModel: model });
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
    const s = await busyWorld({ brandModel: model });
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
    const s = await busyWorld({ brandModel: new FakeBrandModel(() => answer), logger: log.logger });
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
    const s = await busyWorld({ brandModel: slow, brandDeadlineMs: 50, logger: log.logger });
    const started = Date.now();
    const res = await s.as().post('/api/brand/assistant/ask', { question: 'How did we do?', page: 'OVERVIEW' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(log.answers().at(-1)!.fields).toMatchObject({ failure: 'TIMEOUT' });

    const broken = await busyWorld({
      brandModel: new FakeBrandModel(() => {
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
    const model = new GeminiBrandAssistant({ client, model: 'gemini-test' });
    const s = await busyWorld({ brandModel: model });
    const res = await s
      .as()
      .post('/api/brand/assistant/ask', { question: 'Which store needs attention?', page: 'NETWORK' });
    expect(res.body.source).toBe('AI');
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.tools.length)).toEqual([2, 2, 0]); // the third request must answer
    expect(requests[0]!.system).toMatch(/Every number you write must appear in the data or a tool result/);
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
    const s = await busyWorld({ brandModel: model });
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
    const s = await busyWorld({ brandModel: model });
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
    const s = await busyWorld({ brandModel: model });
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
    const s = await busyWorld({ brandModel: model });
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
