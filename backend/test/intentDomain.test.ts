import { describe, expect, it } from 'vitest';
import {
  AI_WINDOW_MS,
  decideInboundPolicy,
  inServiceWindow,
  isHumanRequest,
  isOptOutRequest,
  messageKindFor,
  nextAiWindow,
  truncateInbound,
} from '../src/domain/conversationPolicy.js';
import { buildFallbackDecision } from '../src/domain/fallbackDecision.js';
import {
  applyWebEvent,
  looksLikePii,
  matchSearchCategory,
  normalizeSearchTerm,
  type IntentClassification,
  type WebEvent,
} from '../src/domain/intentClassification.js';
import {
  checkIntentToken,
  encodeIntentToken,
  extractIntentToken,
  hashIntentToken,
  prefilledText,
  TOKEN_PATTERN,
} from '../src/domain/intentToken.js';
import { AgentDecisionSchema } from '../src/ports/agent.js';

let clock = 0;
const ev = (type: WebEvent['type'], extra: Partial<WebEvent> = {}): WebEvent => ({
  type,
  productId: null,
  variantId: null,
  matchedCategory: null,
  entry: null,
  at: new Date(Date.UTC(2026, 9, 5, 10, 0, clock++)).toISOString(),
  ...extra,
});
const product = (type: WebEvent['type'], pid = 'prd_1', vid = 'var_1') => ev(type, { productId: pid, variantId: vid });
const run = (...events: WebEvent[]) =>
  events.reduce<IntentClassification | null>((state, e) => applyWebEvent(state, e), null)!;

describe('storefront intent classification (docs/04 §11.2)', () => {
  it.each([
    ['visit only', [ev('STOREFRONT_VISIT')], 'VISIT', 'VISIT_ONLY', 'NO_MEANINGFUL_INTENT'],
    ['search', [ev('STOREFRONT_VISIT'), ev('SEARCH')], 'SEARCH', 'SEARCH_EXPLORATION', 'NO_MEANINGFUL_INTENT'],
    [
      'product exploration (one view)',
      [product('PRODUCT_VIEW')],
      'PRODUCT_VIEW',
      'PRODUCT_EXPLORATION',
      'NO_MEANINGFUL_INTENT',
    ],
    ['product detail view', [product('PRODUCT_DETAIL_VIEW')], 'PRODUCT_VIEW', 'PRODUCT_EXPLORATION', 'INTERESTED'],
    [
      'consideration: 2 detail views of the same product',
      [product('PRODUCT_DETAIL_VIEW'), product('PRODUCT_DETAIL_VIEW')],
      'CONSIDERATION',
      'PRODUCT_CONSIDERATION',
      'INTERESTED',
    ],
    [
      'consideration: variant selected',
      [product('PRODUCT_VIEW'), product('VARIANT_SELECTED')],
      'CONSIDERATION',
      'PRODUCT_CONSIDERATION',
      'INTERESTED',
    ],
    ['cart', [product('PRODUCT_VIEW'), product('ADD_TO_CART')], 'CART', 'CART_ABANDONMENT', 'HIGH_INTENT'],
    [
      'checkout',
      [product('ADD_TO_CART'), product('CHECKOUT_STARTED')],
      'CHECKOUT',
      'CHECKOUT_ABANDONMENT',
      'HIGH_INTENT',
    ],
    [
      'store-oriented ("Need it today?")',
      [product('PRODUCT_VIEW'), ev('WHATSAPP_CLICK', { entry: 'STORE_NEED', productId: 'prd_1' })],
      'PRODUCT_VIEW',
      'STORE_ORIENTED',
      'HIGH_INTENT',
    ],
  ] as const)('%s', (_label, events, stage, type, strength) => {
    const result = run(...events);
    expect([result.stage, result.type, result.strength]).toEqual([stage, type, strength]);
  });

  it('two views of different products are not consideration; two PRODUCT_VIEWs of one product are INTERESTED', () => {
    expect(run(product('PRODUCT_DETAIL_VIEW', 'a'), product('PRODUCT_DETAIL_VIEW', 'b')).stage).toBe('PRODUCT_VIEW');
    expect(run(product('PRODUCT_VIEW'), product('PRODUCT_VIEW')).strength).toBe('INTERESTED');
  });

  it('stage is monotonic: a later weak event never lowers it', () => {
    const result = run(
      product('ADD_TO_CART'),
      ev('STOREFRONT_VISIT'),
      product('PRODUCT_VIEW', 'prd_2', 'var_9'),
      ev('SEARCH'),
    );
    expect(result.stage).toBe('CART');
    expect(result.type).toBe('CART_ABANDONMENT');
    expect(result.strength).toBe('HIGH_INTENT');
    expect(result.productId).toBe('prd_2'); // the last product engaged with
    expect(result.eventCount).toBe(4);
  });

  it('STORE_ORIENTED overrides the type at any stage, but not the stage; a CHAT click keeps the type', () => {
    const store = run(
      product('CHECKOUT_STARTED'),
      ev('WHATSAPP_CLICK', { entry: 'STORE_NEED' }),
      product('ADD_TO_CART'),
    );
    expect([store.stage, store.type]).toEqual(['CHECKOUT', 'STORE_ORIENTED']);
    const chat = run(product('ADD_TO_CART'), ev('WHATSAPP_CLICK', { entry: 'CHAT' }));
    expect([chat.stage, chat.type, chat.strength]).toEqual(['CART', 'CART_ABANDONMENT', 'HIGH_INTENT']);
    expect(run(ev('WHATSAPP_CLICK', { entry: 'CHAT' })).stage).toBe('VISIT');
  });

  it('search terms: normalized, PII-looking terms flagged, matched only to catalogue labels', () => {
    expect(normalizeSearchTerm('  Vitamin   C SERUM  ')).toBe('vitamin c serum');
    expect(normalizeSearchTerm('x'.repeat(200))).toHaveLength(80);
    expect(looksLikePii('asha@example.com')).toBe(true);
    expect(looksLikePii('call 98200 12345')).toBe(true);
    expect(looksLikePii('spf 50 sunscreen')).toBe(false);
    const catalogue = { categories: ['Serum', 'Sunscreen'], tags: ['vitamin-c', 'hydrating'] };
    expect(matchSearchCategory('vitamin c serums', catalogue)).toBe('Serum');
    expect(matchSearchCategory('vitamin c', catalogue)).toBe('vitamin-c');
    expect(matchSearchCategory('lipstick', catalogue)).toBeNull();
  });
});

describe('intent token (docs/06 §10.1)', () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);

  it('128-bit random value as 26 Crockford Base32 characters; only the SHA-256 hash is stored', () => {
    const token = encodeIntentToken(bytes);
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(encodeIntentToken(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(encodeIntentToken(new Uint8Array(16).fill(255))).toBe('7' + 'Z'.repeat(25));
    expect(hashIntentToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIntentToken(token)).not.toContain(token);
    expect(() => encodeIntentToken(new Uint8Array(8))).toThrow();
  });

  it('is detected anywhere in the text and stripped before storage', () => {
    const token = encodeIntentToken(bytes);
    expect(TOKEN_PATTERN.test(`hi ${prefilledText(token)} thanks`)).toBe(true);
    expect(extractIntentToken(`Hello ${prefilledText(token)} I need it today`)).toEqual({
      token,
      text: 'Hello I need it today',
    });
    expect(extractIntentToken(prefilledText(token))).toEqual({ token, text: '' });
    expect(extractIntentToken('START_BUILDWISE_TOOSHORT')).toEqual({ token: null, text: 'START_BUILDWISE_TOOSHORT' });
  });

  it('validation: unknown, other brand, expired, already used', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const valid = { brandId: 'b1', expiresAt: '2026-10-05T10:30:00Z', consumedAt: null };
    expect(checkIntentToken(valid, 'b1', now)).toBeNull();
    expect(checkIntentToken(null, 'b1', now)).toBe('TOKEN_UNKNOWN');
    expect(checkIntentToken(valid, 'b2', now)).toBe('TOKEN_WRONG_BRAND');
    expect(checkIntentToken(valid, 'b1', new Date('2026-10-05T10:30:00Z'))).toBe('TOKEN_EXPIRED');
    expect(checkIntentToken({ ...valid, consumedAt: '2026-10-05T10:01:00Z' }, 'b1', now)).toBe('TOKEN_ALREADY_USED');
  });
});

describe('conversation policy (docs/07 §10, §17)', () => {
  const now = new Date('2026-10-05T10:00:00Z');

  it('opt-out keywords and human requests', () => {
    for (const t of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE']) expect(isOptOutRequest(t), t).toBe(true);
    for (const t of ["don't stop", 'stop by the store tomorrow', 'start']) expect(isOptOutRequest(t), t).toBe(false);
    expect(isHumanRequest('Can I talk to a person?')).toBe(true);
    expect(isHumanRequest('Is the serum good for oily skin?')).toBe(false);
  });

  it('24-hour window decides SESSION vs TEMPLATE', () => {
    expect(inServiceWindow(null, now)).toBe(false);
    expect(messageKindFor('2026-10-04T10:00:01Z', now)).toBe('SESSION');
    expect(messageKindFor('2026-10-04T10:00:00Z', now)).toBe('TEMPLATE');
    expect(messageKindFor(null, now)).toBe('TEMPLATE');
  });

  it('AI limit: 10 per 5 minutes, then one wait notice per window, then silence; a new window resets', () => {
    let w = { windowStart: null as string | null, count: 0, noticeSent: false };
    for (let i = 0; i < 10; i++) {
      const r = nextAiWindow(w, now);
      expect(r.allowed).toBe(true);
      w = r.next;
    }
    const eleventh = nextAiWindow(w, now);
    expect(eleventh).toMatchObject({ allowed: false, sendWaitNotice: true });
    const twelfth = nextAiWindow(eleventh.next, now);
    expect(twelfth).toMatchObject({ allowed: false, sendWaitNotice: false });
    expect(nextAiWindow(twelfth.next, new Date(now.getTime() + AI_WINDOW_MS)).allowed).toBe(true);
  });

  it('inbound policy: opt-out > already opted out > handoff > rate limit', () => {
    const ok = { allowed: true, sendWaitNotice: false };
    expect(decideInboundPolicy({ text: 'STOP', consentState: 'OPTED_IN', humanHandoff: false, aiWindow: ok })).toEqual({
      reply: 'NONE',
      reason: 'OPT_OUT_REQUEST',
    });
    expect(
      decideInboundPolicy({ text: 'hi', consentState: 'OPTED_OUT', humanHandoff: false, aiWindow: ok }).reply,
    ).toBe('NONE');
    expect(
      decideInboundPolicy({ text: 'hi', consentState: 'UNKNOWN', humanHandoff: true, aiWindow: ok }),
    ).toMatchObject({
      reason: 'HUMAN_HANDOFF',
    });
    expect(
      decideInboundPolicy({
        text: 'hi',
        consentState: 'UNKNOWN',
        humanHandoff: false,
        aiWindow: { allowed: false, sendWaitNotice: true },
      }),
    ).toEqual({ reply: 'WAIT_NOTICE', reason: 'AI_RATE_LIMITED' });
    expect(decideInboundPolicy({ text: 'hi', consentState: 'UNKNOWN', humanHandoff: false, aiWindow: ok })).toEqual({
      reply: 'AUTOMATED',
    });
  });

  it('truncates inbound text to 2,000 characters', () => {
    expect(truncateInbound('a'.repeat(5000))).toHaveLength(2000);
    expect(truncateInbound('short')).toBe('short');
  });
});

describe('deterministic fallback decision (docs/03 §16.2)', () => {
  it('validates against AgentDecisionSchema and never claims price, stock or policy', () => {
    const decision = buildFallbackDecision({
      runtime: 'MOCK',
      wantsHuman: false,
      handoffEnabled: true,
      brandName: 'Demo Beauty Co',
      intent: { type: 'CART_ABANDONMENT', productTitle: 'Vitamin C Glow Serum' },
    });
    expect(AgentDecisionSchema.parse(decision)).toBeTruthy();
    expect(decision).toMatchObject({ runtime: 'MOCK', next_best_action: { action: 'NO_ACTION' }, tool_calls: [] });
    expect(decision.reply.text).toContain('Vitamin C Glow Serum');
    expect(decision.reply.text).not.toMatch(/₹|\bin stock\b|price|refund|return policy/i);
  });

  it('a request for a person → HUMAN_HANDOFF when handoff is enabled, otherwise a normal reply', () => {
    const on = buildFallbackDecision({
      runtime: 'MOCK',
      wantsHuman: true,
      handoffEnabled: true,
      brandName: 'B',
      intent: null,
    });
    expect(on.next_best_action.action).toBe('HUMAN_HANDOFF');
    expect(AgentDecisionSchema.parse(on).intent.intent_type).toBe('SUPPORT_REQUEST');
    const off = buildFallbackDecision({
      runtime: 'MOCK',
      wantsHuman: true,
      handoffEnabled: false,
      brandName: 'B',
      intent: null,
    });
    expect(off.next_best_action.action).toBe('NO_ACTION');
  });
});
