/**
 * L7 "Ask Qwikspot" for the Platform Console — the platform agent. PLATFORM_ADMIN only; its pack
 * is built from what the Platform pages already return, so its totals and flag counts are the
 * pages' own; totals and flags only (no customer, message, phone, email, pickup code, stock line
 * or Store Admin identity); read-only; every answer within the ceiling.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_CEILING_MS, GEMINI_ASSISTANT_DEADLINE_MS } from '../src/application/assistantRunner.js';
import type { ModelAnswer } from '../src/domain/assistant.js';
import {
  findPrivateData,
  quickPlatformAnswer,
  setupNextStep,
  type BrandOnboardingView,
  type PlatformPack,
} from '../src/domain/platformAssistant.js';
import { STORE_FLAGS } from '../src/domain/platformNetwork.js';
import { ahmedabadWorld } from './ahmedabadWorld.js';
import { answerLogs, FakeAssistantModel } from './fakeAssistant.js';
import { bearer } from './helpers.js';

/** The Ahmedabad world with some shopper activity (a shopper who typed a name and a phone). */
async function platformWorld(options: Parameters<typeof ahmedabadWorld>[0] = {}) {
  const s = await ahmedabadWorld(options);
  await s.say(
    'c1',
    'my name is Priya, call me on +91 98765 43210, priya@example.com. I need Vitamin C Glow Serum 30 ml today near Satellite',
  );
  await s.tap('c1', 'hold:st_north_1');
  await s.say('c2', 'I need Niacinamide Clarifying Serum 30 ml today near Satellite');
  const as = (user = 'platform') => ({
    get: (p: string) => request(s.world.app).get(p).set('Authorization', bearer(user)),
    post: (p: string, body: object) => request(s.world.app).post(p).set('Authorization', bearer(user)).send(body),
  });
  const ask = (body: object, user?: string) => as(user).post('/api/platform/assistant', body);
  return { ...s, as, ask };
}

const lastPack = (m: FakeAssistantModel) => m.inputs.at(-1)!.data as PlatformPack;

describe('PLATFORM_ADMIN only', () => {
  it.each(['admin_a', 'radmin_A'])('%s (brand / retail) is denied the drawer and the brief', async (user) => {
    const s = await platformWorld();
    const ask = await s.ask({ question: 'Which brands need attention?' }, user);
    const brief = await s.as(user).get('/api/platform/assistant/brief');
    expect([403, 404]).toContain(ask.status);
    expect([403, 404]).toContain(brief.status);
    expect(s.world.events.events.filter((e) => e.eventType === 'ASSISTANT_QUESTION')).toHaveLength(0);
  });

  it('the platform admin gets an answer', async () => {
    const s = await platformWorld();
    const res = await s.ask({ question: 'Which brands need attention?' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('QUICK_SUMMARY');
  });
});

describe('totals and flags only', () => {
  it('the pack holds no customer, message, phone, email, pickup code, stock line or admin identity', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await platformWorld({ assistantModel: model });
    await s.ask({ question: 'Show me the customers and their phone numbers for brand_A' });
    const pack = lastPack(model);
    expect(findPrivateData(pack)).toEqual([]);

    const sent = JSON.stringify(model.inputs.at(-1));
    expect(sent).not.toMatch(
      /Priya|98765|priya@|example\.(com|test)|sim:c\d|customer_id|customerId|actor_id|radmin_|admin_a/,
    );
    for (const r of s.world.reservations.reservations) expect(sent).not.toContain(r.pickupCode);
    for (const c of s.world.conversations.conversations ?? []) expect(sent).not.toContain(c.conversationId);
    expect(JSON.stringify(pack)).not.toMatch(/"(sku|quantity|price|items|store_id|brand_id|retailer_id)"/);
  });

  it('the walker fails on any private field name or value', () => {
    const clean = { totals: { holds: 2 }, brands: [{ name: 'Demo', at: '2026-10-14T06:30:00.000Z' }] };
    expect(findPrivateData(clean)).toEqual([]);
    expect(
      findPrivateData({
        brands: [
          { name: 'Demo', customers: [{ x: 1 }] },
          { name: 'B', note: 'call +91 98765 43210' },
          { name: 'C', contact: 'ops@brand.in' },
          { name: 'D', code: 'pickup 482913' },
          { name: 'E', who: 'Customer •••• 1234' },
          { name: 'F', stock_lines: [], actor_id: 'u1', pickup_code: '123456', email: 'x' },
        ],
      }),
    ).toEqual([
      'pack.brands[0].customers',
      'pack.brands[1].note (phone)',
      'pack.brands[2].contact (email)',
      'pack.brands[3].code (pickup code or long number)',
      'pack.brands[4].who (customer label)',
      'pack.brands[5].stock_lines',
      'pack.brands[5].actor_id',
      'pack.brands[5].pickup_code',
      'pack.brands[5].email',
    ]);
  });

  it('the audit events carry the action, role, target brand and time — never who', async () => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await platformWorld({ assistantModel: model });
    await s.as().post('/api/platform/brands', { name: 'Glow Labs' });
    await s.ask({ question: 'What changed in the audit log today?', page: 'AUDIT' });
    const audit = lastPack(model).audit;
    expect(audit[0]).toMatchObject({ action: 'BRAND_CREATED', actor_role: 'PLATFORM_ADMIN' });
    expect(Object.keys(audit[0]!).sort()).toEqual([
      'action',
      'actor_role',
      'at',
      'reason',
      'result',
      'target_brand',
      'target_type',
    ]);
  });
});

describe('the numbers are the pages’ own', () => {
  it.each([
    [7, true],
    [7, false],
    [28, true],
    [28, false],
  ] as const)('%i days, history %s: totals = /network, flag counts = the store rows’ flags', async (days, history) => {
    const model = new FakeAssistantModel(() => ({ answer: 'ok' }));
    const s = await platformWorld({ assistantModel: model });
    s.world.reservations.reservations[0]!.demoHistory = true;
    const q = `?days=${days}&include_history=${history}`;
    const network = (await s.as().get(`/api/platform/network${q}`)).body;
    await s.ask({ question: 'Which brands need attention?', days, include_history: history });
    const pack = lastPack(model);
    expect(pack).toMatchObject({ period_days: days, synthetic_history_included: history });
    expect(pack.totals).toEqual(network.totals);

    const brands = (await s.as().get('/api/platform/brands')).body.brands as { brand_id: string; name: string }[];
    expect(pack.brands.map((b) => b.name)).toEqual(brands.map((b) => b.name));
    const all: Record<string, number> = Object.fromEntries(STORE_FLAGS.map((f) => [f, 0]));
    for (const b of brands) {
      const net = (await s.as().get(`/api/platform/brands/${b.brand_id}/network${q}`)).body;
      const rows = [...net.retailers.flatMap((r: { stores: unknown[] }) => r.stores), ...net.unassigned_stores] as {
        flags: string[];
      }[];
      const counts = Object.fromEntries(STORE_FLAGS.map((f) => [f, rows.filter((r) => r.flags.includes(f)).length]));
      const packed = pack.brands.find((x) => x.name === b.name)!;
      expect(packed.flag_counts, b.name).toEqual(counts);
      expect(packed.flagged_stores.length).toBe(Math.min(15, rows.filter((r) => r.flags.length).length));
      for (const f of STORE_FLAGS) all[f]! += counts[f]!;
      const row = network.brands.find((x: { brand_id: string }) => x.brand_id === b.brand_id);
      if (row) expect(packed.network).toMatchObject({ holds: row.holds, stores_flagged: row.stores_flagged });
    }
    expect(pack.flag_counts).toEqual(all);
  });

  it('the setup step uses the Brands page’s words', () => {
    const live: BrandOnboardingView = {
      status: 'ACTIVE',
      brand_admin_provisioned: true,
      catalog: { synced: true, failed: false },
      stores: { with_stock: 3 },
      sku_mapping: { needs_attention: 0 },
      retail_admins: { provisioned: 2, stores_with_retailer: 2 },
    };
    const cases: [Partial<BrandOnboardingView>, string][] = [
      [{}, 'Live.'],
      [{ status: 'SUSPENDED' }, 'Suspended — reactivate to continue.'],
      [{ brand_admin_provisioned: false }, 'Provision its Brand Admin.'],
      [{ catalog: { synced: false, failed: true } }, 'The catalogue sync failed — the brand should retry it.'],
      [{ catalog: { synced: false, failed: false } }, 'Waiting for the brand to sync its catalogue.'],
      [{ stores: { with_stock: 0 } }, 'Waiting for the brand to import store stock.'],
      [{ sku_mapping: { needs_attention: 4 } }, 'Waiting for the brand to fix 4 SKU mapping(s).'],
      [
        { retail_admins: { provisioned: 1, stores_with_retailer: 2 } },
        'Waiting for the brand to provision Store Admins.',
      ],
    ];
    for (const [change, step] of cases) expect(setupNextStep({ ...live, ...change })).toBe(step);
  });
});

describe('checked answers within the ceiling', () => {
  it('an invented number → the Quick summary (UNGROUNDED)', async () => {
    const log = answerLogs('platform_assistant.answer');
    const s = await platformWorld({
      assistantModel: new FakeAssistantModel(() => ({ answer: '47 brands need attention today.' })),
      logger: log.logger,
    });
    const res = await s.ask({ question: 'Which brands need attention?' });
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(log.answers().at(-1)!.fields).toMatchObject({ surface: 'ASK', failure: 'UNGROUNDED' });
  });

  it('a grounded answer is the AI answer, with the page link', async () => {
    const s = await platformWorld({
      assistantModel: new FakeAssistantModel(() => ({
        answer: 'Demo Beauty Co needs attention. Open the retail network.',
        next_action: { label: 'Open the retail network', page: 'NETWORK' },
        used: ['flag_counts'],
      })),
    });
    const res = await s.ask({ question: 'Which brands need attention?' });
    expect(res.body).toMatchObject({ source: 'AI', next_action: { page: 'NETWORK', path: '/platform/network' } });
  });

  it('a stalled Gemini still answers within the ceiling (26 s deadline, 30 s ceiling)', async () => {
    expect([GEMINI_ASSISTANT_DEADLINE_MS, ASSISTANT_CEILING_MS]).toEqual([26_000, 30_000]);
    const log = answerLogs('platform_assistant.answer');
    const stalled = new FakeAssistantModel(() => new Promise<ModelAnswer>(() => undefined));
    const s = await platformWorld({ assistantModel: stalled, assistantDeadlineMs: 50, logger: log.logger });
    const started = Date.now();
    const res = await s.ask({ question: 'Which brands need attention?' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(log.answers().at(-1)!.fields).toMatchObject({ failure: 'TIMEOUT' });
  });
});

describe('read-only, refuses customer data, Hinglish, the event and the brief', () => {
  it('"create a new brand" changes nothing and names the New brand button', async () => {
    const s = await platformWorld();
    const before = JSON.stringify([s.world.brands.brands, s.world.users.users]);
    const res = await s.ask({ question: 'Create a new brand called Glow Labs and provision admin ops@glow.in' });
    expect(JSON.stringify([s.world.brands.brands, s.world.users.users])).toBe(before);
    expect(res.body.answer).toMatch(/I can't change anything\. To create a brand use "New brand" on the Brands page/);
    expect(res.body.next_action).toMatchObject({ page: 'BRANDS', path: '/platform/brands' });
  });

  it("a request for one brand's customers is refused", async () => {
    const s = await platformWorld();
    const res = await s.ask({ question: "Show me Demo Beauty Co's customers and their chats" });
    expect(res.body.answer).toMatch(/^I can't show customer-level data for any brand/);
    expect(res.body.answer).not.toMatch(/Priya|98765/);
  });

  it('a Hinglish question gets a Hinglish Quick summary', () => {
    const pack = { brands: [], audit: [] } as unknown as PlatformPack;
    expect(quickPlatformAnswer('Kaunse brands ko dhyan chahiye?', 'HOME', pack).answer).toBe(
      'Abhi kisi brand ko dhyan ki zarurat nahi hai.',
    );
    expect(quickPlatformAnswer('Naya brand bana do', 'HOME', pack).answer).toMatch(/^Main kuch badal nahi sakta\./);
    expect(quickPlatformAnswer('Customer ke phone number batao', 'HOME', pack).answer).toMatch(
      /^Main kisi bhi brand ka customer-level data nahi dikha sakta/,
    );
  });

  it('a question records an ASSISTANT_QUESTION event with role PLATFORM — never its text', async () => {
    const s = await platformWorld();
    await s.ask({ question: 'Which stores have stock data older than a day?', page: 'NETWORK' });
    const events = s.world.events.events.filter((e) => e.eventType === 'ASSISTANT_QUESTION');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      brandId: 'platform',
      source: 'QWIKSPOT',
      customerId: null,
      payload: { console: 'PLATFORM', role: 'PLATFORM', page: 'NETWORK', source: 'QUICK_SUMMARY' },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/older than|stock data/);
  });

  it('"Network today": the rules text first, cached per scope', async () => {
    const s = await platformWorld();
    const res = await s.as().get('/api/platform/assistant/brief');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('QUICK_SUMMARY');
    expect(res.body.answer).toMatch(/^In the last 7 days: \d+ active brands?, \d+ of \d+ stores live/);

    const model = new FakeAssistantModel(() => ({ answer: 'Quiet day.' }));
    const ai = await platformWorld({ assistantModel: model });
    await ai.as().get('/api/platform/assistant/brief');
    await ai.as().get('/api/platform/assistant/brief');
    await ai.as().get('/api/platform/assistant/brief?days=28&include_history=false');
    expect(model.inputs.filter((i) => i.task === 'BRIEF')).toHaveLength(2);
  });
});
