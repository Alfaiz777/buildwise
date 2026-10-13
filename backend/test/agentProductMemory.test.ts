/**
 * L2-WhatsApp replies: a customer who writes in directly has no storefront intent, so nothing
 * is bound to the conversation. The mock agent still lists the products a generic word means,
 * keeps the product across turns and greets by brand name. Through the real pipeline
 * (in-memory repositories, the mock catalogue); the agent logic is channel-neutral.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { matchProducts, matchSize } from '../src/domain/catalogMatch.js';
import { clarifyReply, whichProductReply } from '../src/domain/agentReplies.js';
import type { CatalogEntry } from '../src/domain/agentTools.js';
import type { ToolCall, ToolResult } from '../src/ports/agent.js';
import { decisionInput, emptyContext } from './agentFixtures.js';
import { buildScenarioWorld } from './scenarioWorld.js';

const MINERAL_50 = 'var_2011';
const GEL_50 = 'var_2013';
const replyText = (res: request.Response) => res.body.outbound_messages[0].text as string;
const optionIds = (res: request.Response) =>
  (res.body.outbound_messages[0].options ?? []).map((o: { option_id: string }) => o.option_id) as string[];

/** The scenario world plus sunscreen stock at Colaba Store (sc_A). */
async function sunscreenWorld() {
  const s = await buildScenarioWorld();
  const variants = await s.world.products.listVariants('brand_A');
  await s.world.inventory.upsertStock(
    'brand_A',
    [MINERAL_50, GEL_50].map((variantId) => {
      const v = variants.find((x) => x.variantId === variantId)!;
      return {
        storeId: 'sc_A',
        sku: v.sku,
        canonicalSku: v.canonicalSku!,
        variantId,
        quantity: 4,
        offlinePrice: v.price,
      };
    }),
    () => 'IN_STOCK',
  );
  return s;
}

describe('a generic product word lists the matching products (matchCatalog)', () => {
  const catalog = [
    { title: 'Mineral Sunscreen SPF 50', category: 'Sunscreen' },
    { title: 'Ultra-Light Gel Sunscreen SPF 50', category: 'Sunscreen' },
    { title: 'Oil-Free Gel Moisturiser', category: 'Moisturiser' },
    { title: 'Vitamin C Glow Serum', category: 'Serum' },
  ];
  const titles = (q: string) => matchProducts(q, catalog).map((p) => p.title);

  it('"sunscreen" → both sunscreens; a distinctive word still wins over the category', () => {
    expect(titles('Is the sunscreen available near Bandra today?')).toEqual([
      'Mineral Sunscreen SPF 50',
      'Ultra-Light Gel Sunscreen SPF 50',
    ]);
    expect(titles('sunscreens')).toHaveLength(2);
    expect(titles('mineral sunscreen near Bandra today')).toEqual(['Mineral Sunscreen SPF 50']);
    expect(titles('the gel sunscreen')).toEqual(['Ultra-Light Gel Sunscreen SPF 50']);
  });

  it('stop words and very short tokens name nothing', () => {
    expect(titles('is it available near me today?')).toEqual([]);
    expect(titles('I need one for the store')).toEqual([]);
    expect(titles('c')).toEqual([]);
  });

  it('a size is matched as a whole ("50 g" is not found inside "150 g")', () => {
    const sizes = [{ title: '50 g' }, { title: '80 g' }];
    expect(matchSize('Mineral Sunscreen SPF 50, 50g please', sizes)?.title).toBe('50 g');
    expect(matchSize('the 80 g one', sizes)?.title).toBe('80 g');
    expect(matchSize('150 g', sizes)).toBeNull();
    expect(matchSize('Mineral Sunscreen SPF 50', sizes)).toBeNull();
  });
});

describe('"which product" names the options and sizes', () => {
  it('candidates with sizes, one per line; without candidates, example names', () => {
    const text = whichProductReply([
      { title: 'Mineral Sunscreen SPF 50', sizes: ['50 g', '80 g'] },
      { title: 'Ultra-Light Gel Sunscreen SPF 50', sizes: ['50 g'] },
    ]).text;
    expect(text).toBe(
      'Which one do you mean?\n• Mineral Sunscreen SPF 50 (50 g, 80 g)\n• Ultra-Light Gel Sunscreen SPF 50 (50 g)\nReply with the name and size.',
    );
    expect(whichProductReply([], ['A Serum', 'B Cream', 'C Wash', 'D']).text).toBe(
      'Which product and size are you looking for? For example: A Serum, B Cream or C Wash.',
    );
    expect(whichProductReply([]).text).toBe('Which product and size are you looking for?');
    expect(text.length).toBeLessThan(1024);
  });

  it('"sunscreen near Colaba today" lists both sunscreens with sizes; no store is searched yet', async () => {
    const s = await sunscreenWorld();
    const res = await s.say('w1', 'Is the sunscreen available near Colaba today?');
    expect(res.body.decision).toMatchObject({ action: 'NO_ACTION', guardrail_status: 'ALLOWED' });
    expect(replyText(res)).toContain('• Mineral Sunscreen SPF 50 (50 g, 80 g)');
    expect(replyText(res)).toContain('• Ultra-Light Gel Sunscreen SPF 50 (50 g)');
    const calls = s.lastRecommendation().trace!.tool_calls.map((c) => c.tool);
    expect(calls).toContain('get_product_context');
    expect(calls).not.toContain('find_nearby_stores');
  });

  it('answering with the name and size carries on with the store search, in the area given before', async () => {
    const s = await sunscreenWorld();
    await s.say('w1', 'Is the sunscreen available near Colaba today?');
    const res = await s.say('w1', 'Mineral Sunscreen SPF 50, 50 g');
    expect(res.body.decision).toMatchObject({ action: 'STORE_DISCOVERY', guardrail_status: 'ALLOWED' });
    expect(optionIds(res)).toContain('hold:sc_A');
    expect(s.lastRecommendation().targetVariantId).toBe(MINERAL_50);
  });

  it('a product named without a size asks for the size of that product only', async () => {
    const s = await sunscreenWorld();
    const res = await s.say('w1', 'Mineral sunscreen near Colaba today');
    expect(replyText(res)).toBe(
      'Which size would you like?\n• Mineral Sunscreen SPF 50 (50 g, 80 g)\nReply with the size.',
    );
  });
});

describe('follow-up questions keep the product', () => {
  it('store search → hold → "Is it good for oily skin?" answers from Mineral Sunscreen; "Which is better?" compares it with the Gel', async () => {
    const s = await sunscreenWorld();
    const found = await s.say('w1', 'Mineral Sunscreen SPF 50, 50 g, near Colaba today');
    expect(found.body.decision).toMatchObject({ action: 'STORE_DISCOVERY' });
    expect(optionIds(found)).toContain('hold:sc_A');

    // The product is now bound: a conversation intent, recorded through record_customer_intent.
    const intent = s.world.intents.intents.find((i) => i.source === 'CONVERSATION')!;
    expect(intent).toMatchObject({ variantId: MINERAL_50, type: 'URGENT_PURCHASE', status: 'ACTIVE', followUp: null });
    expect(intent.customerId).toBe(s.lastRecommendation().customerId);

    const hold = await s.tap('w1', 'hold:sc_A');
    expect(hold.body.decision).toMatchObject({ action: 'STORE_RESERVATION', guardrail_status: 'ALLOWED' });
    expect(s.world.reservations.reservations).toHaveLength(1);

    const skin = await s.say('w1', 'Is it good for oily skin?');
    expect(skin.body.decision).toMatchObject({ action: 'EDUCATE' });
    expect(replyText(skin)).toContain('Mineral Sunscreen SPF 50');
    expect(replyText(skin)).toContain('sensitive, all'); // Mineral's verified skin_type, not the Gel's
    expect(replyText(skin)).not.toContain('oily, combination');

    const better = await s.say('w1', 'Which is better?');
    expect(better.body.decision).toMatchObject({ action: 'COMPARE' });
    expect(replyText(better)).toContain('Mineral Sunscreen SPF 50');
    expect(replyText(better)).toContain('Ultra-Light Gel Sunscreen SPF 50');
  });

  it('asking for the area keeps the product: "…today" → which area? → "Colaba" → the store', async () => {
    const s = await sunscreenWorld();
    const ask = await s.say('w1', 'I need the Mineral Sunscreen SPF 50 50 g today');
    expect(ask.body.decision).toMatchObject({ action: 'STORE_DISCOVERY' });
    expect(optionIds(ask)).toEqual([]);
    const res = await s.say('w1', 'Colaba');
    expect(res.body.decision).toMatchObject({ action: 'STORE_DISCOVERY' });
    expect(optionIds(res)).toContain('hold:sc_A');
    expect(s.lastRecommendation().targetVariantId).toBe(MINERAL_50);
  });

  it('a product named now wins over the bound one', async () => {
    const s = await sunscreenWorld();
    await s.say('w1', 'Mineral Sunscreen SPF 50, 50 g, near Colaba today');
    const res = await s.say('w1', 'Is the gel sunscreen good for oily skin?');
    expect(res.body.decision).toMatchObject({ action: 'EDUCATE' });
    expect(replyText(res)).toContain('Ultra-Light Gel Sunscreen SPF 50');
    expect(replyText(res)).toContain('oily, combination');
  });

  describe('without anything bound or pending (runtime order)', () => {
    const catalog: CatalogEntry[] = [
      {
        product_id: 'p_min',
        title: 'Mineral Sunscreen SPF 50',
        category: 'Sunscreen',
        variants: [
          { variant_id: 'v_min_50', title: '50 g' },
          { variant_id: 'v_min_80', title: '80 g' },
        ],
      },
      {
        product_id: 'p_gel',
        title: 'Ultra-Light Gel Sunscreen SPF 50',
        category: 'Sunscreen',
        variants: [{ variant_id: 'v_gel_50', title: '50 g' }],
      },
    ];
    const run = async (
      text: string,
      history: { direction: 'INBOUND' | 'OUTBOUND'; text: string }[],
      activeVariant: string | null,
    ) => {
      const seen: ToolCall[] = [];
      const tools = {
        execute: async (call: ToolCall): Promise<ToolResult> => {
          seen.push(call);
          const output =
            call.tool === 'get_customer_history'
              ? {
                  active_reservations: activeVariant
                    ? [{ reservation_id: 'r1', store_id: 's', store_name: 'S', variant_id: activeVariant }]
                    : [],
                  reservation_counts: {},
                }
              : { status: 'NOT_FOUND', product: null, variant_id: null, alternatives: [], candidates: [] };
          return { tool: call.tool, status: 'EXECUTED', output, resultReference: null, reasonCode: null };
        },
      };
      const context = emptyContext({ catalog, history: [...history, { direction: 'INBOUND', text }] });
      const decision = await new MockAgentRuntime().decide(decisionInput({ type: 'TEXT', text }, context), tools);
      return { seen, decision };
    };

    it('the active reservation comes before the history', async () => {
      const { seen } = await run(
        'Is it good for oily skin?',
        [{ direction: 'INBOUND', text: 'tell me about the gel sunscreen' }],
        'v_min_50',
      );
      expect(seen.map((c) => c.tool)).toEqual(['get_customer_history', 'get_product_context']);
      expect(seen[1]!.input).toEqual({ variant_id: 'v_min_50' });
    });

    it('otherwise the most recent of the last 3 inbound messages that names a single product', async () => {
      const { seen } = await run(
        'Is it good for oily skin?',
        [
          { direction: 'INBOUND', text: 'Do you have the mineral sunscreen?' },
          { direction: 'OUTBOUND', text: 'Happy to help with Mineral Sunscreen SPF 50.' },
          { direction: 'INBOUND', text: 'what about the gel sunscreen' },
          { direction: 'INBOUND', text: 'ok' },
        ],
        null,
      );
      expect(seen.at(-1)).toEqual({ tool: 'get_product_context', input: { variant_id: 'v_gel_50' } });
    });

    it('older than the last 3 inbound messages is not used: the agent asks, with example names', async () => {
      const { seen, decision } = await run(
        'Is it good for oily skin?',
        [
          { direction: 'INBOUND', text: 'mineral sunscreen please' },
          { direction: 'INBOUND', text: 'ok' },
          { direction: 'INBOUND', text: 'thanks' },
          { direction: 'INBOUND', text: 'hmm' },
        ],
        null,
      );
      expect(seen.at(-1)!.input).toEqual({ query: 'Is it good for oily skin?' });
      expect(decision.next_best_action.action).toBe('NO_ACTION');
      expect(decision.reply.text).toContain(
        'For example: Mineral Sunscreen SPF 50 or Ultra-Light Gel Sunscreen SPF 50.',
      );
    });
  });
});

describe('the shopper pages take the brand name from the API', () => {
  it('GET /api/demo-storefront/products returns the brand display name with the catalogue', async () => {
    const s = await sunscreenWorld();
    const res = await request(s.world.app).get('/api/demo-storefront/products?brand_id=brand_A');
    expect(res.status).toBe(200);
    expect(res.body.brand).toEqual({ brand_id: 'brand_A', display_name: 'Brand brand_A' });
    expect(res.body.products.length).toBeGreaterThan(0);
  });
});

describe('friendlier greeting', () => {
  it('"hi" names the brand and gives two example products; no tools are called', async () => {
    const s = await sunscreenWorld();
    const res = await s.say('w1', 'hi');
    expect(res.body.decision).toMatchObject({ action: 'NO_ACTION' });
    expect(replyText(res)).toMatch(
      /^Hi! Welcome to Brand brand_A\. I can tell you about a product, check which nearby store has it today, or help you order online\. Which product are you looking for\? For example: .+ or .+\.$/,
    );
    expect(s.lastRecommendation().trace!.tool_calls).toEqual([]);
  });

  it('with a product bound (storefront intent) the wording is unchanged', async () => {
    const s = await sunscreenWorld();
    const res = await s.startFromStore('c1', 'hi');
    expect(replyText(res)).toBe(
      'Happy to help with Vitamin C Glow Serum. Would you like product details, a nearby store that has it today, or to order online?',
    );
  });

  it('an unclear later message asks for the product without the welcome', () => {
    const open = { brandName: 'AquaSkin', examples: ['A', 'B', 'C'] };
    expect(clarifyReply(null, { ...open, welcome: true }).text).toBe(
      'Hi! Welcome to AquaSkin. I can tell you about a product, check which nearby store has it today, or help you order online. Which product are you looking for? For example: A or B.',
    );
    expect(clarifyReply(null, { ...open, welcome: false }).text).toBe(
      'I can tell you about a product, check which nearby store has it today, or help you order online. Which product are you looking for? For example: A or B.',
    );
    expect(clarifyReply('Glow Serum', { ...open, welcome: true }).text).toMatch(/^Happy to help with Glow Serum\./);
  });
});
