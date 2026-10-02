import { describe, expect, it } from 'vitest';
import { messageKindFor } from '../src/domain/conversationPolicy.js';
import { composeFollowUp, FOLLOW_UP_TEMPLATES, OPT_OUT_LINE } from '../src/domain/followUpMessages.js';
import {
  DEFAULT_FOLLOW_UP_SETTINGS,
  evaluateFollowUp,
  FOLLOW_UP_TYPES,
  isInactive,
  resolveFollowUpSettings,
  type FollowUpCustomerView,
  type FollowUpIntentView,
} from '../src/domain/followUpPolicy.js';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const intent = (overrides: Partial<FollowUpIntentView> = {}): FollowUpIntentView => ({
  type: 'CART_ABANDONMENT',
  strength: 'HIGH_INTENT',
  status: 'ACTIVE',
  matchedCategory: null,
  detectedAt: '2026-10-05T09:50:00.000Z',
  lastEventAt: '2026-10-05T09:58:00.000Z',
  tokenConsumedAt: null,
  followUpStatus: null,
  ...overrides,
});
const customer = (overrides: Partial<FollowUpCustomerView> = {}): FollowUpCustomerView => ({
  channel: 'SIMULATOR',
  consentState: 'OPTED_IN',
  lastProactiveAt: null,
  ...overrides,
});
const evaluate = (
  i: Partial<FollowUpIntentView> = {},
  c: Partial<FollowUpCustomerView> | null = {},
  conversation: { humanHandoff: boolean; lastInboundAt: string | null } | null = null,
  settings = DEFAULT_FOLLOW_UP_SETTINGS,
) =>
  evaluateFollowUp({
    intent: intent(i),
    customer: c === null ? null : customer(c),
    conversation,
    enabledChannels: ['SIMULATOR'],
    settings,
    now: NOW,
  });

describe('evaluateFollowUp — every reason code (docs/00 §11.8 Change 11, D5)', () => {
  it('eligible: a known, opted-in customer who abandoned a cart; due_at = last activity + delay', () => {
    expect(evaluate()).toEqual({
      decision: 'FOLLOW_UP_ELIGIBLE',
      reason: 'ELIGIBLE',
      dueAt: '2026-10-05T10:58:00.000Z',
      priority: 'NORMAL',
    });
  });

  it('checkout abandonment is HIGH priority with a shorter delay', () => {
    expect(evaluate({ type: 'CHECKOUT_ABANDONMENT' })).toMatchObject({
      priority: 'HIGH',
      dueAt: '2026-10-05T10:28:00.000Z',
    });
  });

  it.each([
    ['ALREADY_CONVERTED', { status: 'CONVERTED' as const }, {}],
    ['ALREADY_FOLLOWED_UP', { followUpStatus: 'SENT' as const }, {}],
    ['WEAK_INTENT (visit only)', { type: 'VISIT_ONLY' as const, strength: 'NO_MEANINGFUL_INTENT' as const }, {}],
    [
      'WEAK_INTENT (product exploration)',
      { type: 'PRODUCT_EXPLORATION' as const, strength: 'INTERESTED' as const },
      {},
    ],
    [
      'WEAK_INTENT (search matched nothing)',
      { type: 'SEARCH_EXPLORATION' as const, strength: 'NO_MEANINGFUL_INTENT' as const },
      {},
    ],
    [
      'INTENT_TYPE_DISABLED (search off by default)',
      { type: 'SEARCH_EXPLORATION' as const, matchedCategory: 'Serum' },
      {},
    ],
    ['CUSTOMER_NOT_REACHABLE (anonymous)', {}, null],
    ['CUSTOMER_NOT_REACHABLE (no channel identity)', {}, { channel: null }],
    ['CHANNEL_DISABLED', {}, { channel: 'WHATSAPP' as const }],
    ['OPTED_OUT', {}, { consentState: 'OPTED_OUT' }],
    ['NO_CONSENT (not opted in)', {}, { consentState: 'NOT_OPTED_IN' }],
    ['NO_CONSENT (unknown)', {}, { consentState: 'UNKNOWN' }],
    ['CUSTOMER_ALREADY_IN_CONVERSATION (token used)', { tokenConsumedAt: '2026-10-05T09:59:00.000Z' }, {}],
    ['FREQUENCY_LIMIT', {}, { lastProactiveAt: '2026-10-05T01:00:00.000Z' }],
  ])('%s', (label, i, c) => {
    const result = evaluate(i, c);
    expect(result.decision).toBe('FOLLOW_UP_NOT_ELIGIBLE');
    expect(result.reason).toBe(label.split(' ')[0]);
  });

  it('HUMAN_HANDOFF and CUSTOMER_ALREADY_IN_CONVERSATION come from the conversation', () => {
    expect(evaluate({}, {}, { humanHandoff: true, lastInboundAt: null }).reason).toBe('HUMAN_HANDOFF');
    expect(evaluate({}, {}, { humanHandoff: false, lastInboundAt: '2026-10-05T09:55:00.000Z' }).reason).toBe(
      'CUSTOMER_ALREADY_IN_CONVERSATION',
    );
    // An inbound message from before this intent began does not block it.
    expect(evaluate({}, {}, { humanHandoff: false, lastInboundAt: '2026-10-04T09:00:00.000Z' }).decision).toBe(
      'FOLLOW_UP_ELIGIBLE',
    );
  });

  it('intent-level reasons come before customer-level ones (anonymous browsing is WEAK_INTENT)', () => {
    expect(evaluate({ type: 'PRODUCT_EXPLORATION' }, null).reason).toBe('WEAK_INTENT');
    expect(evaluate({}, null).reason).toBe('CUSTOMER_NOT_REACHABLE');
  });

  it('brand settings: a disabled type, a matched search when enabled, and the frequency window', () => {
    const settings = resolveFollowUpSettings({
      frequency_hours: 1,
      types: { CART_ABANDONMENT: { enabled: false }, SEARCH_EXPLORATION: { enabled: true, delay_minutes: 2 } },
    });
    expect(evaluate({}, {}, null, settings).reason).toBe('INTENT_TYPE_DISABLED');
    expect(evaluate({ type: 'SEARCH_EXPLORATION', matchedCategory: 'Serum' }, {}, null, settings)).toMatchObject({
      decision: 'FOLLOW_UP_ELIGIBLE',
      dueAt: '2026-10-05T10:00:00.000Z',
    });
    expect(
      evaluate({ type: 'PRODUCT_CONSIDERATION' }, { lastProactiveAt: '2026-10-05T08:00:00.000Z' }, null, settings)
        .decision,
    ).toBe('FOLLOW_UP_ELIGIBLE');
  });

  it('the same function re-checked at send time suppresses what changed in between', () => {
    expect(evaluate().decision).toBe('FOLLOW_UP_ELIGIBLE');
    expect(evaluate({ status: 'CONVERTED' }).reason).toBe('ALREADY_CONVERTED');
    expect(evaluate({}, { consentState: 'OPTED_OUT' }).reason).toBe('OPTED_OUT');
    expect(evaluate({}, {}, { humanHandoff: true, lastInboundAt: null }).reason).toBe('HUMAN_HANDOFF');
  });

  it('settings: defaults, and bad values fall back to defaults', () => {
    expect(resolveFollowUpSettings(undefined)).toEqual(DEFAULT_FOLLOW_UP_SETTINGS);
    const s = resolveFollowUpSettings({
      inactivity_minutes: -5,
      types: { CHECKOUT_ABANDONMENT: { priority: 'URGENT', delay_minutes: 'x' } },
    });
    expect(s.inactivityMinutes).toBe(30);
    expect(s.types.CHECKOUT_ABANDONMENT).toEqual({ enabled: true, delayMinutes: 30, priority: 'HIGH' });
  });

  it('abandonment only after the inactivity threshold', () => {
    const settings = resolveFollowUpSettings({ inactivity_minutes: 1 });
    expect(isInactive('2026-10-05T09:59:30.000Z', settings, NOW)).toBe(false);
    expect(isInactive('2026-10-05T09:59:00.000Z', settings, NOW)).toBe(true);
  });
});

describe('composeFollowUp — personalised, verified data only (D6)', () => {
  const base = {
    brandName: 'Demo Beauty Co',
    productTitle: 'Vitamin C Glow Serum',
    variantTitle: '30 ml',
    category: null,
    kind: 'TEMPLATE' as const,
  };

  it.each(FOLLOW_UP_TYPES.map((t) => [t]))(
    '%s: names the brand and product/category, ends with the opt-out line',
    (type) => {
      const m = composeFollowUp({ ...base, type, category: 'Serum' });
      expect(m.text).toContain('Demo Beauty Co');
      expect(m.text).toMatch(type === 'SEARCH_EXPLORATION' ? /Serum/ : /Vitamin C Glow Serum \(30 ml\)/);
      expect(m.text.endsWith(OPT_OUT_LINE)).toBe(true);
      expect(m.templateName).toBe(FOLLOW_UP_TEMPLATES[type].name);
      // Never a price, stock or availability claim, an internal ID or a token.
      expect(m.text).not.toMatch(/₹|\d+\.\d{2}|in stock|available|var_|prd_|int_|START_QWIKSPOT/i);
    },
  );

  it('SESSION messages are free text without a template; TEMPLATE messages carry only brand + verified parameters', () => {
    const session = composeFollowUp({ ...base, type: 'CART_ABANDONMENT', kind: 'SESSION' });
    expect(session).toMatchObject({ kind: 'SESSION', templateName: null, parameters: {} });
    const template = composeFollowUp({ ...base, type: 'CART_ABANDONMENT' });
    expect(template.parameters).toEqual({ brand: 'Demo Beauty Co', product: 'Vitamin C Glow Serum (30 ml)' });
  });

  it('the search message uses the matched catalogue category, never the raw search term', () => {
    const m = composeFollowUp({
      ...base,
      type: 'SEARCH_EXPLORATION',
      category: 'Serum',
      productTitle: null,
      variantTitle: null,
    });
    expect(m.text).toContain('You were looking at Serum.');
    expect(m.text).not.toContain('vitamin c serum for my oily');
  });

  it('fillers are sanitised and bounded', () => {
    const m = composeFollowUp({
      ...base,
      type: 'CART_ABANDONMENT',
      productTitle: '<b>{{brand}}</b>' + 'x'.repeat(200),
    });
    expect(m.text).not.toMatch(/[<>{}]/);
    expect(m.parameters.product!.length).toBeLessThanOrEqual(80);
  });

  it('message kind: SESSION inside the 24-hour window, TEMPLATE outside', () => {
    expect(messageKindFor('2026-10-05T09:00:00.000Z', NOW)).toBe('SESSION');
    expect(messageKindFor(null, NOW)).toBe('TEMPLATE');
  });
});
