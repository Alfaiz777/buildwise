/**
 * L9: suggested replies after an answer — 2–3 choices by rules (never model text), WhatsApp
 * reply buttons (≤ 3, title ≤ 20 characters, inside the 24-hour window), chips on the web chat;
 * none after a closing, a hold confirmation or a handoff; a tap is the shopper's message.
 */
import { describe, expect, it } from 'vitest';
import {
  asTypedQuickReply,
  compareWord,
  quickReplyOption,
  quickReplyText,
  suggestedReplies,
  type QuickReplyKind,
  type QuickReplyState,
} from '../src/domain/quickReplies.js';
import { WHATSAPP_LIMITS, validateMessage } from '../src/domain/whatsappLimits.js';
import type { InboundMessage } from '../src/ports/messaging.js';
import { ahmedabadWorld } from './ahmedabadWorld.js';

const GEL = { title: 'Ultra-Light Gel Sunscreen SPF 50', word: 'Gel' };
const product: QuickReplyState = {
  action: 'EDUCATE',
  executed: null,
  hasButtons: false,
  turn: null,
  language: 'ENGLISH',
  handedOff: false,
  handoffEnabled: true,
  productBound: true,
  productTitle: 'Mineral Sunscreen SPF 50',
  compareWith: GEL,
  onlinePurchaseAvailable: true,
  storeSearchRan: true,
  storesFound: false,
  windowOpen: true,
};
const labels = (s: Partial<QuickReplyState>) => suggestedReplies({ ...product, ...s }).map((o) => o.label);

describe('the choices, by rules', () => {
  it('after a product answer: stores, compare, a person — WhatsApp reply buttons', () => {
    const options = suggestedReplies(product);
    expect(options.map((o) => o.label)).toEqual(['Show stores near me', 'Compare with Gel', 'Talk to a person']);
    expect(options.every((o) => o.optionId.startsWith('qr:'))).toBe(true);
    // As WhatsApp sends them: reply buttons, ≤ 3, each title ≤ 20 characters.
    const sent = validateMessage({ text: 'It suits oily skin.', options });
    expect(sent.options).toHaveLength(3);
    expect(sent.options!.every((o) => o.label.length <= WHATSAPP_LIMITS.buttonLabel)).toBe(true);
  });

  it('no alternative: stores, buy online, a person; a store search with no stock: another area, online, a person', () => {
    expect(labels({ compareWith: null })).toEqual(['Show stores near me', 'Buy online', 'Talk to a person']);
    expect(labels({ action: 'STORE_DISCOVERY' })).toEqual(['Check another area', 'Buy online', 'Talk to a person']);
    expect(labels({ action: 'COMPARE' })).toEqual(['Show stores near me', 'Buy online', 'Talk to a person']);
  });

  it.each([
    ['a closing "thanks"', { turn: 'THANKS' }],
    ['a closing "bye"', { turn: 'BYE' }],
    ['"later"', { turn: 'LATER' }],
    ['a hold confirmation', { action: 'STORE_RESERVATION', executed: 'RESERVATION_CREATED' }],
    ['a handoff', { action: 'HUMAN_HANDOFF' }],
    ['a conversation a person owns', { handedOff: true }],
    ['a turn with its own buttons (store choice, hold confirm)', { hasButtons: true }],
    ['outside the 24-hour window', { windowOpen: false }],
    [
      'a store search that found stores (its card has buttons) and nothing else to offer',
      {
        action: 'STORE_DISCOVERY',
        storesFound: true,
        onlinePurchaseAvailable: false,
        handoffEnabled: false,
      },
    ],
    ['no product in play', { productBound: false }],
    ['a store search that only asks where the shopper is', { action: 'STORE_DISCOVERY', storeSearchRan: false }],
  ] as [string, Partial<QuickReplyState>][])('none after %s', (_case, change) => {
    expect(labels(change)).toEqual([]);
  });

  it('Hinglish conversations get Hinglish labels', () => {
    expect(labels({ language: 'HINGLISH', compareWith: { ...GEL, word: 'Gel' } })).toEqual([
      'Paas ke store dikhao',
      'Gel se compare',
      'Kisi se baat karao',
    ]);
    expect(labels({ language: 'HINGLISH', action: 'STORE_DISCOVERY' })).toEqual([
      'Doosra area dekho',
      'Online lena hai',
      'Kisi se baat karao',
    ]);
  });

  it('every title fits a WhatsApp reply button (≤ 20 characters), in English and Hinglish', () => {
    for (const kind of ['STORES', 'ONLINE', 'AREA', 'PERSON'] as QuickReplyKind[])
      for (const language of ['ENGLISH', 'HINGLISH'] as const)
        expect(quickReplyOption(kind, language).label.length).toBeLessThanOrEqual(20);
  });

  it('the compare word names the alternative and fits the button', () => {
    expect(compareWord('Mineral Sunscreen SPF 50', 'Ultra-Light Gel Sunscreen SPF 50', 'ENGLISH')).toBe('Gel');
    expect(compareWord('Ceramide Barrier Cream', 'Oil-Free Gel Moisturiser', 'ENGLISH')).toBe('Gel');
    expect(compareWord('Niacinamide Clarifying Serum', 'Vitamin C Glow Serum', 'HINGLISH')).toBe('Glow');
    expect(compareWord('Vitamin C Glow Serum', 'Niacinamide Clarifying Serum', 'ENGLISH')).toBeNull(); // no word fits
  });
});

describe('a tap is the shopper message', () => {
  it('the text comes from the choice; compare names the product in full', () => {
    const compare = quickReplyOption('COMPARE', 'ENGLISH', GEL);
    expect(compare.label).toBe('Compare with Gel');
    expect(quickReplyText(compare.optionId)).toBe('Compare with Ultra-Light Gel Sunscreen SPF 50');
    expect(quickReplyText(quickReplyOption('STORES', 'HINGLISH').optionId)).toBe('Paas mein kahan milega?');
    // "Show stores near me" names the answered product, so the store search knows which one.
    const [stores] = suggestedReplies(product);
    expect(stores!.label).toBe('Show stores near me');
    expect(quickReplyText(stores!.optionId)).toBe('Show stores near me for Mineral Sunscreen SPF 50');
    expect(quickReplyText('qr:nope:en')).toBeNull();
    expect(quickReplyText('hold:st_1')).toBeNull();
    const tap: InboundMessage = {
      channel: 'WHATSAPP',
      brandId: 'b',
      externalCustomerRef: 'wa:1',
      externalMessageId: 'wamid.1',
      receivedAt: '2026-10-17T06:30:00.000Z',
      content: { type: 'INTERACTIVE_REPLY', optionId: 'qr:person:en' },
    };
    expect(asTypedQuickReply(tap).content).toEqual({ type: 'TEXT', text: 'Talk to a person' });
    const hold = { ...tap, content: { type: 'INTERACTIVE_REPLY' as const, optionId: 'hold:st_1' } };
    expect(asTypedQuickReply(hold)).toBe(hold);
  });
});

describe('in the conversation (simulator: what WhatsApp and the web chat get)', () => {
  const lastOutbound = (s: Awaited<ReturnType<typeof ahmedabadWorld>>) =>
    s.world.conversations.messages.filter((m) => m.direction === 'OUTBOUND').at(-1)!;

  it('a product answer gets 2–3 choices; tapping one sends its text as the shopper message', async () => {
    const s = await ahmedabadWorld();
    const res = await s.say('q1', 'Is Mineral Sunscreen SPF 50 good for oily skin?');
    expect(res.body.decision).toMatchObject({ action: 'EDUCATE' });
    const options = lastOutbound(s).options ?? [];
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    expect(options.every((o) => o.optionId.startsWith('qr:') && o.label.length <= 20)).toBe(true);
    expect(options.map((o) => o.label)).toContain('Show stores near me');

    const tap = await s.tap('q1', options.find((o) => o.label === 'Show stores near me')!.optionId);
    expect(tap.status).toBeLessThan(300);
    const inbound = s.world.conversations.messages.filter((m) => m.direction === 'INBOUND').at(-1)!;
    expect(inbound).toMatchObject({ messageType: 'TEXT', text: 'Show stores near me for Mineral Sunscreen SPF 50' });
    // The store search goes on for that product: it has two sizes, so the agent asks which one.
    const reply = s.world.conversations.messages.filter((m) => m.direction === 'OUTBOUND').at(-1)!;
    expect(reply.text).toMatch(/Mineral Sunscreen SPF 50/);
    expect(reply.text).not.toMatch(/Which product/);
  });

  it('none after a closing, a hold confirmation or a handoff', async () => {
    const s = await ahmedabadWorld();
    await s.say('q2', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
    await s.tap('q2', 'hold:st_north_1'); // the hold is confirmed
    expect(lastOutbound(s).options?.some((o) => o.optionId.startsWith('qr:')) ?? false).toBe(false);
    await s.say('q2', 'thanks');
    expect(lastOutbound(s).options ?? []).toEqual([]);
    await s.say('q2', 'I want to talk to a person');
    expect(lastOutbound(s).options?.some((o) => o.optionId.startsWith('qr:')) ?? false).toBe(false);
  });

  it('a Hinglish product question gets Hinglish choices', async () => {
    const s = await ahmedabadWorld();
    await s.say('q3', 'Mineral Sunscreen SPF 50 oily skin ke liye theek hai kya?');
    const labels = (lastOutbound(s).options ?? []).map((o) => o.label);
    expect(labels).toContain('Paas ke store dikhao');
    // Its tap is a Hinglish store search for that product.
    const stores = lastOutbound(s).options!.find((o) => o.label === 'Paas ke store dikhao')!;
    const tap = await s.tap('q3', stores.optionId);
    expect(tap.body.decision?.action).not.toBe('HUMAN_HANDOFF');
    expect(s.world.conversations.messages.filter((m) => m.direction === 'INBOUND').at(-1)!.text).toBe(
      'Mineral Sunscreen SPF 50 paas mein kahan milega?',
    );
    expect(lastOutbound(s).text).toMatch(/Mineral Sunscreen SPF 50/);
  });
});
