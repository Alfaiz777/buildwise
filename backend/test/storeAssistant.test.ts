/**
 * L6 "Ask Qwikspot" for the Store Console — the store agent. Its store comes only from the
 * signed-in Retail Admin; its numbers are that store's, with the Today tiles' definitions and the
 * page's period / synthetic-history choice; no shopper's identity reaches Gemini; read-only;
 * every answer within the ceiling (Gemini's, or the rules "Quick summary").
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_CEILING_MS, GEMINI_ASSISTANT_DEADLINE_MS } from '../src/application/assistantRunner.js';
import {
  quickStoreAnswer,
  STORE_ASSISTANT_PROMPT,
  STORE_ASSISTANT_PROMPT_VERSION,
  type StorePack,
} from '../src/domain/storeAssistant.js';
import type { ModelAnswer } from '../src/domain/assistant.js';
import { ahmedabadWorld } from './ahmedabadWorld.js';
import { answerLogs, FakeAssistantModel } from './fakeAssistant.js';
import { bearer } from './helpers.js';

/** The Ahmedabad world with Wellness Mart's Retail Admin and some activity at the store. */
async function storeWorld(options: Parameters<typeof ahmedabadWorld>[0] = {}) {
  const s = await ahmedabadWorld(options);
  for (const [storeId, userId] of [
    ['st_north_1', 'radmin_wellness'],
    ['st_north_2', 'radmin_healthplus'],
  ] as const) {
    s.world.stores.stores.find((x) => x.brandId === 'brand_A' && x.storeId === storeId)!.retailAdminUserId = userId;
    s.world.users.users.push({
      userId,
      role: 'RETAIL_ADMIN',
      brandId: 'brand_A',
      retailerId: 'rtl_north',
      storeId,
      email: `${userId}@example.test`,
      status: 'ACTIVE',
    });
  }
  // Two holds waiting at Wellness Mart (one from a shopper who typed a name and a phone), one at HealthPlus.
  await s.say(
    'c1',
    'my name is Priya, call me on +91 98765 43210. I need Vitamin C Glow Serum 30 ml today near Satellite',
  );
  await s.tap('c1', 'hold:st_north_1');
  await s.say('c2', 'I need Niacinamide Clarifying Serum 30 ml today near Satellite');
  await s.tap('c2', 'hold:st_north_1');
  await s.say('c3', 'Need Gentle Foaming Cleanser 100 ml near CG Road');
  await s.tap('c3', 'hold:st_north_2');
  const as = (user = 'radmin_wellness') => ({
    get: (p: string) => request(s.world.app).get(p).set('Authorization', bearer(user)),
    post: (p: string, body: object) => request(s.world.app).post(p).set('Authorization', bearer(user)).send(body),
  });
  const ask = (body: object, user?: string, storeId = 'st_north_1') =>
    as(user).post(`/api/retail/stores/${storeId}/assistant`, body);
  return { ...s, as, ask };
}

const lastPack = (m: FakeAssistantModel) => m.inputs.at(-1)!.data as StorePack;

describe('the store comes only from the signed-in Retail Admin', () => {
  it('another store is 404 (ask and brief); a Brand Admin is 403', async () => {
    const s = await storeWorld();
    expect((await s.ask({ question: 'How is my store doing?' }, 'radmin_wellness', 'st_north_2')).status).toBe(404);
    expect((await s.as().get('/api/retail/stores/st_north_2/assistant/brief')).status).toBe(404);
    expect((await s.ask({ question: 'How is my store doing?' }, 'admin_a')).status).toBe(403);
    expect((await s.ask({ question: 'How is my store doing?' })).status).toBe(200);
  });

  it("a store id in the question is ignored: the data is still only Wellness Mart's", async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await storeWorld({ assistantModel: model });
    await s.ask({ question: 'Show me st_north_2 and HealthPlus Chemist numbers', page: 'TODAY' });
    const pack = lastPack(model);
    expect(pack.store_name).toBe('Wellness Mart');
    expect(JSON.stringify(pack)).not.toMatch(/HealthPlus|st_north_2|Gentle Foaming/);
    expect(pack.waiting_holds).toHaveLength(2);
  });
});

describe('the store pack uses the tiles and follows the page', () => {
  it('totals equal the Today tiles; with synthetic history hidden its holds drop out (7 / 28 days)', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await storeWorld({ assistantModel: model });
    const tiles = (await s.as().get('/api/retail/stores/st_north_1/summary')).body;
    await s.ask({ question: 'How is my store doing this week?', days: 7, include_history: true });
    expect(lastPack(model).totals).toEqual({
      holds: tiles.reservations,
      picked_up: tiles.completed,
      completion_percent: tiles.completion_pct,
      refused: tiles.refused,
      expired: tiles.expired,
      value_of_pickups: tiles.value.amount,
      currency: tiles.value.currency,
    });
    expect(lastPack(model).totals.holds).toBe(2);

    // One of the two holds becomes synthetic demo history.
    s.world.reservations.reservations.find((r) => r.storeId === 'st_north_1')!.demoHistory = true;
    for (const [days, include, holds] of [
      [7, true, 2],
      [7, false, 1],
      [28, false, 1],
    ] as const) {
      await s.ask({ question: 'How is my store doing?', days, include_history: include });
      const pack = lastPack(model);
      expect(pack).toMatchObject({ period_days: days, synthetic_history_included: include });
      expect(pack.totals.holds, `${days} days, history ${include}`).toBe(holds);
      expect(pack.waiting_holds).toHaveLength(holds);
    }
  });

  it('waiting holds show how long each has waited; low stock (available ≤ 2) is flagged', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await storeWorld({ assistantModel: model });
    await s.ask({ question: 'Which holds are waiting for me?' });
    const pack = lastPack(model);
    expect(pack.now.waiting_for_you).toBe(2);
    expect(pack.waiting_holds[0]).toMatchObject({ waited_minutes: 0, expires_in_minutes: 120 });
    expect(pack.waiting_holds.map((h) => h.customer)).toEqual([
      expect.stringMatching(/^Customer •••• \w{4}$/),
      expect.stringMatching(/^Customer •••• \w{4}$/),
    ]);
    // Wellness Mart has 2 Vitamin C Glow Serum 50 ml in the fixture: low (≤ 2 can still be held).
    expect(pack.stock_attention).toContainEqual(
      expect.objectContaining({ product: 'Vitamin C Glow Serum 50 ml', available: 2, low: true }),
    );
    expect(pack.stock_attention.every((l) => l.low || l.stale)).toBe(true);
  });
});

describe('no personal data reaches Gemini; the answer is checked', () => {
  it('the request carries masked customers only: no name, no phone, no pickup code', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await storeWorld({ assistantModel: model });
    await s.ask({ question: 'Which holds are waiting for me?' });
    const sent = JSON.stringify(model.inputs.at(-1));
    expect(sent).not.toMatch(/Priya|98765|sim:c\d|customer_id|customerId/);
    for (const r of s.world.reservations.reservations) expect(sent).not.toContain(r.pickupCode);
  });

  it.each([
    ['an invented number', { answer: 'You sold 47 serums this week.' }, 'UNGROUNDED'],
    ['a phone number', { answer: 'Call the shopper on +91 98765 43210.' }, 'PII'],
    [
      'a page of another console',
      { answer: 'All good.', next_action: { label: 'Open Network', page: 'NETWORK' } },
      'INVALID',
    ],
  ] as [string, ModelAnswer, string][])(
    'Gemini writes %s → the Quick summary instead (%s)',
    async (_c, answer, failure) => {
      const log = answerLogs('store_assistant.answer');
      const s = await storeWorld({ assistantModel: new FakeAssistantModel(() => answer), logger: log.logger });
      const res = await s.ask({ question: 'How is my store doing this week?' });
      expect(res.body.source).toBe('QUICK_SUMMARY');
      expect(res.body.answer).toMatch(/^In the last 7 days: 2 holds, 0 picked up/);
      expect(log.answers().at(-1)!.fields).toMatchObject({ store_id: 'st_north_1', surface: 'ASK', failure });
    },
  );

  it('a grounded answer is shown as the AI answer, with the page link', async () => {
    const s = await storeWorld({
      assistantModel: new FakeAssistantModel(() => ({
        answer: '2 holds are waiting for you. Confirm them on the Today page.',
        next_action: { label: 'Confirm waiting holds', page: 'TODAY' },
        used: ['waiting_holds'],
      })),
    });
    const res = await s.ask({ question: 'Which holds are waiting for me?' });
    expect(res.body).toMatchObject({
      source: 'AI',
      answer: '2 holds are waiting for you. Confirm them on the Today page.',
      next_action: { page: 'TODAY', path: '/store' },
    });
  });

  it('a stalled Gemini still answers within the ceiling (17 s deadline, 20 s ceiling)', async () => {
    expect([GEMINI_ASSISTANT_DEADLINE_MS, ASSISTANT_CEILING_MS]).toEqual([17_000, 20_000]);
    const log = answerLogs('store_assistant.answer');
    const stalled = new FakeAssistantModel(() => new Promise<ModelAnswer>(() => undefined));
    const s = await storeWorld({ assistantModel: stalled, assistantDeadlineMs: 50, logger: log.logger });
    const started = Date.now();
    const res = await s.ask({ question: 'How is my store doing this week?' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(log.answers().at(-1)!.fields).toMatchObject({ failure: 'TIMEOUT' });
  });
});

describe('read-only, Hinglish, the event and the brief', () => {
  it('"confirm all my holds" changes nothing and names the Confirm button', async () => {
    const s = await storeWorld();
    const before = s.world.reservations.reservations.map((r) => r.status);
    const res = await s.ask({ question: 'Confirm all my waiting holds' });
    expect(s.world.reservations.reservations.map((r) => r.status)).toEqual(before);
    expect(res.body.answer).toMatch(/Use Confirm on the Today page\./);
    expect(res.body.next_action).toMatchObject({ page: 'TODAY', path: '/store' });
  });

  it('a Hinglish question gets a Hinglish Quick summary', () => {
    const pack = {
      waiting_holds: [
        { product: 'Serum', quantity: 1, customer: 'Customer •••• 1234', waited_minutes: 12, expires_in_minutes: 100 },
      ],
      now: { waiting_for_you: 1, confirmed: 0, ready_for_pickup: 0 },
      stock_attention: [],
      demand_near_you: [],
    } as unknown as StorePack;
    expect(quickStoreAnswer('Mere kitne hold wait kar rahe hain?', 'TODAY', pack).answer).toMatch(
      /^1 hold aapke confirm ka wait kar rahe hain; sabse purana 12 min se\./,
    );
  });

  it('a question records an ASSISTANT_QUESTION event — never its text', async () => {
    const s = await storeWorld();
    await s.ask({ question: 'What should I stock up before Saturday?', page: 'STOCK' });
    const events = s.world.events.events.filter((e) => e.eventType === 'ASSISTANT_QUESTION');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      brandId: 'brand_A',
      source: 'QWIKSPOT',
      entityReference: 'st_north_1',
      customerId: null,
      payload: { console: 'STORE', page: 'STOCK', source: 'QUICK_SUMMARY' },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/stock up|Saturday/);
  });

  it('"Today at your store": the waiting holds first, then the period, with a next action; cached per scope', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'Busy morning.' }));
    const s = await storeWorld();
    const res = await s.as().get('/api/retail/stores/st_north_1/assistant/brief');
    expect(res.body).toMatchObject({ source: 'QUICK_SUMMARY', next_action: { page: 'TODAY' } });
    expect(res.body.answer).toMatch(
      /^2 holds are waiting for you to confirm; the longest has waited 0 min\. In the last 7 days: 2 holds, 0 picked up\./,
    );

    const ai = await storeWorld({ assistantModel: model });
    await ai.as().get('/api/retail/stores/st_north_1/assistant/brief');
    await ai.as().get('/api/retail/stores/st_north_1/assistant/brief');
    await ai.as().get('/api/retail/stores/st_north_1/assistant/brief?days=28&include_history=false');
    expect(model.inputs.filter((i) => i.task === 'BRIEF')).toHaveLength(2);
  });
});

describe('store prompt — money (UI-P2)', () => {
  it('asks for ₹ with thousands separators, never INR', () => {
    expect(STORE_ASSISTANT_PROMPT_VERSION).toBe('ASK_QWIKSPOT_STORE_V3');
    expect(STORE_ASSISTANT_PROMPT).toContain('like ₹6,360 — never "INR 6360"');
  });
});
