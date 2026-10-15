/**
 * L5 conversation test set: shopper messages on the Ahmedabad demo network, in multi-turn
 * chains (the product and the area carry across turns). Each checked message names the actions
 * that are acceptable — the first is what the rules runtime does — and the reply rules that
 * apply. Run against the mock in `npm test` (test/conversationFixtures.test.ts) and against
 * real Gemini in the live eval (test/eval/gemini.eval.test.ts).
 */
import type { AiAction } from '../../src/domain/ai.js';
import type { Language } from '../../src/domain/conversationalReplies.js';

export interface Expectation {
  /** Acceptable actions; the first is what the rules runtime (mock) does. */
  actions: AiAction[];
  /**
   * SOCIAL: a conversational reply (≤ 2 sentences, ≤ 250 chars, ≤ 1 emoji, no commerce facts).
   * CLOSING: the same, and no buttons.
   */
  turn?: 'SOCIAL' | 'CLOSING';
  /** The reply's language (checked on SOCIAL / CLOSING replies). */
  language?: Language;
  /** The "Talk to a person" button is offered. */
  handoffButton?: boolean;
  /** No reservation is created by this message. */
  noHold?: boolean;
  /** Verified wording that must appear (e.g. the price). */
  includes?: RegExp;
}

export type Step = ({ say: string } | { tap: string }) & { expect: Expectation };

export interface ConversationCase {
  id: string;
  title: string;
  steps: Step[];
}

const CLOSING = (language: Language = 'ENGLISH'): Expectation => ({
  actions: ['NO_ACTION'],
  turn: 'CLOSING',
  language,
  noHold: true,
});
const SOCIAL = (language: Language = 'ENGLISH', extra: Partial<Expectation> = {}): Expectation => ({
  actions: ['NO_ACTION'],
  turn: 'SOCIAL',
  language,
  noHold: true,
  ...extra,
});
const SEARCH: Expectation = { actions: ['STORE_DISCOVERY'], noHold: true };

export const CONVERSATIONS: ConversationCase[] = [
  {
    id: 'A',
    title: 'a store card, then thanks / later / ok / bye',
    steps: [
      { say: 'I need Niacinamide Clarifying Serum 30 ml today near Satellite', expect: SEARCH },
      { say: 'Thanks for the response, I will buy it later! 😊👍', expect: CLOSING() },
      { say: 'ok', expect: SOCIAL() },
      { say: 'bye', expect: CLOSING() },
    ],
  },
  {
    id: 'B',
    title: 'Hinglish: kal tak milega → area → price → baad mein',
    steps: [
      { say: 'Vitamin C Glow Serum 30 ml kal tak milega?', expect: SEARCH },
      { say: 'navrangpura', expect: SEARCH },
      { say: 'kitne ka hai', expect: { actions: ['EDUCATE', 'NO_ACTION'], includes: /795/ } },
      { say: 'theek hai baad mein lunga', expect: CLOSING('HINGLISH') },
    ],
  },
  {
    id: 'C',
    title: 'typos, an alias area, a typed store name, hold, cancel',
    steps: [
      { say: 'sunscrean satelite', expect: { actions: ['NO_ACTION', 'STORE_DISCOVERY'], noHold: true } },
      { say: 'Mineral Sunscreen SPF 50, 50 g near prahlad nagar', expect: SEARCH },
      { say: "I'll go to CityCare", expect: SEARCH },
      { say: 'hold it', expect: { actions: ['STORE_RESERVATION'] } },
      { say: 'cancel my hold', expect: { actions: ['NO_ACTION'], noHold: true } },
    ],
  },
  {
    id: 'D',
    title: 'an unserved area, an area button, a switch, a store in the other area',
    steps: [
      { say: 'Ceramide Barrier Cream 50 g today in Bopal', expect: SEARCH },
      { tap: 'area:Satellite', expect: SEARCH },
      { say: 'navrangpura', expect: SEARCH },
      { say: "I'll go to MediGlow", expect: SEARCH },
    ],
  },
  {
    id: 'E',
    title: 'product questions: skin type, comparison, price, authenticity, thanks',
    steps: [
      { say: 'Is Hyaluronic Hydra Serum good for dry skin?', expect: { actions: ['EDUCATE'], noHold: true } },
      {
        say: 'Which is better, Hyaluronic Hydra Serum or Niacinamide Clarifying Serum?',
        expect: { actions: ['COMPARE'], noHold: true },
      },
      { say: 'how much is the Hyaluronic Hydra Serum 30 ml?', expect: { actions: ['EDUCATE'], includes: /699/ } },
      { say: 'is it original?', expect: { actions: ['EDUCATE', 'NO_ACTION', 'HUMAN_HANDOFF'], noHold: true } },
      { say: 'great, thanks!', expect: CLOSING() },
    ],
  },
  {
    id: 'F',
    title: 'hello, a complaint, off-topic, then a person',
    steps: [
      { say: 'Hi', expect: { actions: ['NO_ACTION'], noHold: true } },
      { say: 'this is useless', expect: SOCIAL('ENGLISH', { handoffButton: true }) },
      { say: 'who won the cricket match yesterday?', expect: SOCIAL() },
      { say: 'talk to a person', expect: { actions: ['HUMAN_HANDOFF'], noHold: true } },
    ],
  },
  {
    id: 'G',
    title: 'reactions, a greeting, an unknown product, frustration',
    steps: [
      { say: '👍', expect: SOCIAL() },
      { say: '🙏', expect: CLOSING() },
      { say: 'good morning', expect: SOCIAL() },
      { say: 'do you sell shampoo?', expect: { actions: ['NO_ACTION', 'EDUCATE'], noHold: true } },
      { say: 'why so slow', expect: SOCIAL('ENGLISH', { handoffButton: true }) },
      { say: 'kya aap bot ho?', expect: { actions: ['NO_ACTION'], noHold: true } },
    ],
  },
  {
    id: 'H',
    title: 'Hindi (Devanagari) closings',
    steps: [
      { say: 'धन्यवाद', expect: CLOSING('HINDI') },
      { say: 'ठीक है', expect: SOCIAL('HINDI') },
    ],
  },
  {
    id: 'I',
    title: 'Navrangpura by street, other stores, a switch, a typed name, hold, thanks',
    steps: [
      { say: 'Need Gentle Foaming Cleanser 100 ml near CG Road', expect: SEARCH },
      { tap: 'other_stores', expect: SEARCH },
      { say: 'prahlad nagar', expect: SEARCH },
      { say: 'GlowUp', expect: SEARCH },
      { tap: 'hold:st_sat_2', expect: { actions: ['STORE_RESERVATION'] } },
      { say: 'thank you so much', expect: CLOSING() },
    ],
  },
  {
    id: 'J',
    title: 'a product, home delivery, ok bye',
    steps: [
      {
        say: 'I want the Overnight Repair Night Cream 30 g',
        expect: { actions: ['NO_ACTION', 'EDUCATE', 'STORE_DISCOVERY'], noHold: true },
      },
      { say: 'deliver it to me', expect: { actions: ['ONLINE_PURCHASE'], noHold: true } },
      { say: 'ok bye', expect: CLOSING() },
    ],
  },
];

export const checkedMessages = () => CONVERSATIONS.reduce((n, c) => n + c.steps.length, 0);
