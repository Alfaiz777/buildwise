/**
 * L5 natural replies: social turns (thanks, later, ok, bye, a complaint, off-topic) get a short
 * reply in the customer's language; a closing has no buttons; a complaint offers a person; a
 * model-written text with a commerce fact falls back to the deterministic reply; every inbound
 * message logs one reply-timing line without PII.
 */
import { describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { OPTION } from '../src/domain/agentReplies.js';
import {
  checkConversationalText,
  classifyTurn,
  CLOSING_TURNS,
  detectLanguage,
  finishConversationalReply,
  socialReply,
  SOCIAL_TURNS,
  type Language,
  type TurnType,
} from '../src/domain/conversationalReplies.js';
import type { Logger } from '../src/lib/logger.js';
import type { AgentDecision, AgentRuntime, DecisionInput } from '../src/ports/agent.js';
import { ahmedabadWorld, type SimulatorResponse } from './ahmedabadWorld.js';

const STORES = ['Wellness Mart', 'Wellness', 'GlowUp Beauty', 'GlowUp', 'HealthPlus Chemist', 'Skin Studio'];

describe('classifyTurn / detectLanguage', () => {
  it.each([
    ['Thanks for the response, I will buy it later! 😊👍', 'LATER'],
    ['theek hai baad mein lunga', 'LATER'],
    ['thanks!', 'THANKS'],
    ['🙏', 'THANKS'],
    ['धन्यवाद', 'THANKS'],
    ['ok', 'OK'],
    ['👍', 'OK'],
    ['ठीक है', 'OK'],
    ['bye', 'BYE'],
    ['ok bye', 'BYE'],
    ['hello', 'GREETING'],
    ['नमस्ते', 'GREETING'],
    ['this is useless', 'COMPLAINT'],
    ['why so slow', 'COMPLAINT'],
    ['who won the cricket match?', 'OFF_TOPIC'],
    ['awesome', 'COMPLIMENT'],
  ] as const)('%s → %s', (text, turn) => expect(classifyTurn(text)).toBe(turn));

  it.each([
    'thanks, is it good for oily skin?',
    'ok which one is cheaper?',
    'I need it today',
    'kitne ka hai',
    'Mineral Sunscreen SPF 50, 50 g',
    '',
  ])('a question or a request is never small talk: %s', (text) => expect(classifyTurn(text)).toBeNull());

  it.each([
    ['Thanks, I will buy it later', 'ENGLISH'],
    ['theek hai baad mein lunga', 'HINGLISH'],
    ['kal tak milega?', 'HINGLISH'],
    ['धन्यवाद', 'HINDI'],
  ] as const)('%s → %s', (text, language) => expect(detectLanguage(text)).toBe(language));
});

describe('checkConversationalText — every forbidden pattern is caught', () => {
  const check = (text: string, customerText = 'thanks') =>
    checkConversationalText(text, { storeNames: STORES, customerText });
  it.each([
    ["You're welcome! It's ₹795 at the store.", 'PRICE'],
    ['Sure, it costs Rs 795.', 'PRICE'],
    ['Great, we still have it in stock.', 'STOCK'],
    ['Only 2 left, so come soon!', 'STOCK'],
    ["It's just 0.3 km away. See you!", 'DISTANCE'],
    ["We'll deliver it in 4-5 days.", 'DELIVERY_TIME'],
    ['It can be delivered tomorrow.', 'DELIVERY_TIME'],
    ['There is a 10% discount today.', 'PROMOTION'],
    ['Delivery is free for you!', 'PROMOTION'],
    ['We guarantee it will work.', 'PROMOTION'],
    ['Wellness Mart has it, pop in anytime!', 'STORE_NAME'],
    ['See you at GlowUp! 😊', 'STORE_NAME'],
    ['a'.repeat(260), 'TOO_LONG'],
    ['Thanks. Come back soon. Bye now.', 'TOO_MANY_SENTENCES'],
    ['Thanks! 😊🙏', 'TOO_MANY_EMOJI'],
  ] as const)('%s → %s', (text, reason) => expect(check(text)).toBe(reason));

  it('Devanagari in, Devanagari out', () => {
    expect(check("You're welcome!", 'धन्यवाद')).toBe('LANGUAGE');
    expect(check('आपका स्वागत है!', 'धन्यवाद')).toBeNull();
  });

  it('a friendly closing passes, "feel free" included', () => {
    expect(check("No problem! Feel free to message me here whenever you're ready. 😊")).toBeNull();
    expect(check('No problem! Whenever you are ready, just message me here.')).toBeNull();
  });

  it('without limits (a clarifying question) only the content rules apply', () => {
    const long =
      'Which sunscreen do you mean? • Mineral Sunscreen SPF 50 (50 g, 80 g) • Ultra-Light Gel Sunscreen SPF 50. Tell me and I will check.';
    expect(checkConversationalText(long, { storeNames: STORES, limits: false })).toBeNull();
    expect(checkConversationalText(`${long} It is ₹649.`, { storeNames: STORES, limits: false })).toBe('PRICE');
  });
});

describe('socialReply — every fixed text keeps the rules it asks of the model', () => {
  const languages: Language[] = ['ENGLISH', 'HINGLISH', 'HINDI'];
  for (const turn of SOCIAL_TURNS) {
    for (const language of languages) {
      for (const productTitle of [null, 'Niacinamide Clarifying Serum']) {
        it(`${turn} · ${language} · ${productTitle ? 'with' : 'without'} a product`, () => {
          const reply = socialReply({
            turn,
            language,
            productTitle,
            brandName: 'Demo Beauty Co',
            handoffEnabled: true,
          });
          const customerText = language === 'HINDI' ? 'धन्यवाद' : 'thanks';
          expect(checkConversationalText(reply.text, { storeNames: STORES, customerText })).toBeNull();
          expect(detectLanguage(reply.text)).toBe(language);
          expect(reply.options?.map((o) => o.option_id) ?? []).toEqual(turn === 'COMPLAINT' ? [OPTION.handoff] : []);
        });
      }
    }
  }

  it('turn rules: no buttons after a closing; a person after a complaint (only when handoff is on)', () => {
    const withButtons = {
      message_type: 'INTERACTIVE' as const,
      text: 'Sure!',
      options: [{ option_id: OPTION.buyOnline, label: 'Home delivery' }],
    };
    for (const turn of CLOSING_TURNS) {
      expect(finishConversationalReply(withButtons, turn, true)).toEqual({ message_type: 'TEXT', text: 'Sure!' });
    }
    const complaint = finishConversationalReply({ message_type: 'TEXT', text: 'Sorry.' }, 'COMPLAINT', true);
    expect(complaint.options).toEqual([{ option_id: OPTION.handoff, label: 'Talk to a person' }]);
    expect(
      finishConversationalReply({ message_type: 'TEXT', text: 'Sorry.' }, 'COMPLAINT', false).options,
    ).toBeUndefined();
  });
});

/** Stands in for Gemini: a NO_ACTION with the text, turn and buttons a test gives it. */
class StubGemini implements AgentRuntime {
  readonly runtime = 'ADK_GEMINI' as const;
  next: { text: string; turn?: TurnType; options?: string[] } = { text: 'Hi!' };
  async decide(_input: DecisionInput): Promise<AgentDecision> {
    const { text, turn, options = [] } = this.next;
    return {
      runtime: 'ADK_GEMINI',
      intent: { intent_type: 'UNKNOWN', confidence: 0.8 },
      intervention: { should_intervene: false, reason: 'stub' },
      next_best_action: { action: 'NO_ACTION', ...(turn ? { turn_type: turn } : {}), reason: 'stub' },
      response_strategy: { tone: 'friendly', include_store_context: false, ask_for_confirmation: false },
      required_tools: [],
      tool_calls: [],
      reply: {
        message_type: options.length ? 'INTERACTIVE' : 'TEXT',
        text,
        ...(options.length ? { options: options.map((id) => ({ option_id: id, label: id })) } : {}),
      },
    };
  }
}

const out = (res: SimulatorResponse) =>
  res.body.outbound_messages[0] as { text: string; options?: { option_id: string }[] };
const ids = (res: SimulatorResponse) => (out(res).options ?? []).map((o) => o.option_id);

describe('the pipeline applies the reply rules', () => {
  it('rules runtime: "Thanks… buy it later" → a closing reply without buttons or a sales question', async () => {
    const s = await ahmedabadWorld();
    await s.say('c1', 'I need Niacinamide Clarifying Serum 30 ml today near Satellite');
    const res = await s.say('c1', 'Thanks for the response, I will buy it later! 😊👍');
    expect(res.body.decision.action).toBe('NO_ACTION');
    expect(out(res).text).toBe(
      "No problem! Whenever you're ready, just message me here and I'll check stock near you again. 😊",
    );
    expect(ids(res)).toEqual([]);
    expect(out(res).text).not.toMatch(/Would you like|\?/);
  });

  it('rules runtime: a Hinglish closing is answered in Hinglish', async () => {
    const s = await ahmedabadWorld();
    await s.say('c1', 'Vitamin C Glow Serum 30 ml kal tak milega?');
    const res = await s.say('c1', 'theek hai baad mein lunga');
    expect(out(res).text).toMatch(/^Koi baat nahi!/);
    expect(detectLanguage(out(res).text)).toBe('HINGLISH');
    expect(ids(res)).toEqual([]);
  });

  it('rules runtime: a complaint apologises and shows "Talk to a person" — no automatic handoff', async () => {
    const s = await ahmedabadWorld();
    await s.say('c1', 'hi');
    const res = await s.say('c1', 'this is useless');
    expect(res.body.decision.action).toBe('NO_ACTION');
    expect(out(res).text).toMatch(/^Sorry about that/);
    expect(ids(res)).toEqual([OPTION.handoff]);
    expect(s.world.conversations.conversations[0]!.humanHandoff).toBeFalsy();
  });

  it('Gemini: a valid closing is sent as written, its buttons removed', async () => {
    const gemini = new StubGemini();
    const s = await ahmedabadWorld({ agent: gemini, backupAgent: new MockAgentRuntime() });
    gemini.next = {
      text: 'Anytime! 😊 Just message me when you need it.',
      turn: 'THANKS',
      options: [OPTION.buyOnline],
    };
    const res = await s.say('c1', 'thanks!');
    expect(out(res).text).toBe('Anytime! 😊 Just message me when you need it.');
    expect(ids(res)).toEqual([]);
  });

  it('Gemini: a backend-recognised closing loses its buttons even when the model gave no turn type', async () => {
    const gemini = new StubGemini();
    const s = await ahmedabadWorld({ agent: gemini, backupAgent: new MockAgentRuntime() });
    gemini.next = { text: 'Sure, talk soon!', options: [OPTION.buyOnline, OPTION.otherStores] };
    const res = await s.say('c1', 'bye');
    expect(ids(res)).toEqual([]);
  });

  it.each([
    ['a price', "No problem! It's ₹649 whenever you want it."],
    ['a store name', 'No problem! GlowUp Beauty will have it for you.'],
    ['a promise', 'No problem! Delivery is free if you order later.'],
    ['three sentences', 'No problem. Take your time. Message me later.'],
  ])('Gemini: a closing with %s is replaced by the fixed reply, and the reason is logged', async (_case, text) => {
    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      error() {},
      warn: (message, fields) => warnings.push({ message, fields }),
    };
    const gemini = new StubGemini();
    const s = await ahmedabadWorld({ agent: gemini, backupAgent: new MockAgentRuntime(), logger });
    gemini.next = { text, turn: 'LATER' };
    const res = await s.say('c1', 'Thanks, I will buy it later');
    expect(out(res).text).toBe(
      "No problem! Whenever you're ready, just message me here and I'll check stock near you again. 😊",
    );
    const rejected = warnings.find((w) => w.message === 'agent.reply_rejected');
    expect(rejected?.fields).toMatchObject({ runtime: 'ADK_GEMINI', turn_type: 'LATER' });
    expect(JSON.stringify(rejected)).not.toContain(text); // the reason code only, never the text
  });

  it('Gemini: a clarifying question with a price falls back to the template', async () => {
    const gemini = new StubGemini();
    const s = await ahmedabadWorld({ agent: gemini, backupAgent: new MockAgentRuntime() });
    gemini.next = { text: 'Which size do you want? The 30 ml is ₹649.', turn: 'CLARIFY' };
    const res = await s.say('c1', 'niacinamide serum');
    expect(out(res).text).not.toMatch(/₹/);
    expect(out(res).text).toMatch(/Which product are you looking for\?|Happy to help/);
  });

  it('Gemini: a complaint gets the "Talk to a person" button added', async () => {
    const gemini = new StubGemini();
    const s = await ahmedabadWorld({ agent: gemini, backupAgent: new MockAgentRuntime() });
    gemini.next = { text: "Sorry about that! I'll do better.", turn: 'COMPLAINT' };
    const res = await s.say('c1', 'not helpful at all');
    expect(ids(res)).toEqual([OPTION.handoff]);
  });
});

describe('reply timing — one line per inbound message, without PII', () => {
  it('logs the path, total time, model time, tool calls and whether the backup answered', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger: Logger = {
      debug() {},
      warn() {},
      error() {},
      info: (message, fields) => {
        if (message === 'conversation.reply_timing') lines.push(fields!);
      },
    };
    const gemini = new StubGemini();
    const s = await ahmedabadWorld({ agent: gemini, backupAgent: new MockAgentRuntime(), logger });
    gemini.next = { text: 'Hi! 😊 How can I help?', turn: 'GREETING' };
    await s.say('c1', 'hello');
    await s.tap('c1', 'areas');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      brand_id: 'brand_A',
      message_type: 'TEXT',
      path: 'GEMINI',
      backup_used: false,
      action: 'NO_ACTION',
      total_ms: expect.any(Number),
      gemini_ms: expect.any(Number),
      tool_calls: expect.any(Number),
    });
    expect(lines[1]).toMatchObject({ path: 'RULES_TAP', gemini_ms: null, rules_ms: expect.any(Number) });
    for (const line of lines) expect(JSON.stringify(line)).not.toMatch(/hello|c1|conv_/);
  });
});
