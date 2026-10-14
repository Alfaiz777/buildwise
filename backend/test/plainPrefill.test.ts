/**
 * L4 plain prefill: the WhatsApp message a shopper sees is only the readable sentence. The chat
 * is linked to the browsing intent by recognising that exact sentence (a hash stored on the
 * single-use, 30-minute token); a "(ref START_QWIKSPOT_…)" from an older link still binds.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  normalizePrefillText,
  pickPrefillMatch,
  prefillTextHash,
  PREFILL_AMBIGUITY_WINDOW_MS,
} from '../src/domain/intentToken.js';
import { bearer, buildTestWorld, refOf, TEST_ORIGIN } from './helpers.js';

type World = ReturnType<typeof buildTestWorld>;
const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };
const SERUM_30 = 'gid://shopify/ProductVariant/2001';
const SENTENCE = "Hi Brand brand_A! I'd like Vitamin C Glow Serum (30 ml) today. Is it available at a store near me?";
let n = 0;

async function world(start = new Date('2026-10-14T10:00:00.000Z')) {
  let now = start;
  const w = buildTestWorld({ now: () => now });
  await w.commerceSync.sync('brand_A', SYSTEM);
  await w.commerceSync.sync('brand_B', SYSTEM);
  return { w, advance: (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000)) };
}
const click = (w: World, session: string, brand = 'brand_A') =>
  request(w.app)
    .post('/api/intents')
    .set('Origin', TEST_ORIGIN)
    .send({
      brand_id: brand,
      web_session_id: session,
      client_event_id: `ce_${++n}`,
      event_type: 'WHATSAPP_CLICK',
      entry: 'STORE_NEED',
      shopify_variant_id: SERUM_30,
    });
const say = (w: World, customer: string, text: string, user = 'admin_a') =>
  request(w.app)
    .post('/api/channels/simulator/messages')
    .set('Authorization', bearer(user))
    .send({ simulator_customer_ref: customer, client_message_id: `cm_${++n}`, content: { type: 'TEXT', text } });
const intentOf = (w: World, session: string) => w.intents.intents.find((i) => i.webSessionId === session)!;
const bound = (w: World) => w.audit.brandEvents.filter((e) => e.action === 'INTENT_TOKEN_BOUND');

describe('the prefilled sentence, compared and matched', () => {
  it('normalised: case, curly quotes, spacing and trailing punctuation do not matter; words do', () => {
    const base = normalizePrefillText(SENTENCE);
    expect(base).toBe(
      "hi brand brand_a! i'd like vitamin c glow serum (30 ml) today. is it available at a store near me",
    );
    for (const variant of [
      `${SENTENCE} `,
      SENTENCE.replace('?', ''),
      SENTENCE.replace("I'd", 'I’d'),
      SENTENCE.toUpperCase(),
      SENTENCE.replace(/ /g, '  '),
      `${SENTENCE.slice(0, -1)}!!`,
    ]) {
      expect(normalizePrefillText(variant)).toBe(base);
      expect(prefillTextHash(variant)).toBe(prefillTextHash(SENTENCE));
    }
    expect(prefillTextHash(SENTENCE.replace('today', 'tomorrow'))).not.toBe(prefillTextHash(SENTENCE));
    expect(prefillTextHash(SENTENCE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('several open tokens for one sentence: the newest binds only within 2 minutes; one binds always', () => {
    const now = new Date('2026-10-14T10:10:00.000Z');
    const at = (minutesAgo: number) => ({ issuedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString() });
    expect(pickPrefillMatch([], now)).toBeNull();
    expect(pickPrefillMatch([at(25)], now)).toEqual(at(25));
    expect(pickPrefillMatch([at(9), at(1)], now)).toEqual(at(1));
    expect(pickPrefillMatch([at(9), at(3)], now)).toBeNull();
    expect(PREFILL_AMBIGUITY_WINDOW_MS).toBe(120_000);
  });
});

describe('binding a WhatsApp chat to the browsing intent without a visible code', () => {
  it('the prefilled text has no "(ref …)"; the token is still created and the reference returned separately', async () => {
    const { w } = await world();
    const res = await click(w, 'ws_plain_000001');
    expect(res.body.whatsapp.prefilled_text).toBe(SENTENCE);
    expect(decodeURIComponent(res.body.whatsapp.wa_link.split('?text=')[1])).toBe(SENTENCE);
    expect(res.body.whatsapp.ref).toMatch(/^START_QWIKSPOT_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(w.tokens.tokens).toHaveLength(1);
    expect(w.tokens.tokens[0]).toMatchObject({ textHash: prefillTextHash(SENTENCE), consumedAt: null });
  });

  it('the exact sentence binds the intent, like a ref did; the agent knows the product', async () => {
    const { w } = await world();
    await click(w, 'ws_plain_000001');
    const res = await say(w, 'shopper_1', `${SENTENCE} `); // WhatsApp may add a trailing space
    expect(res.status).toBe(200);
    const intent = intentOf(w, 'ws_plain_000001');
    expect(intent.tokenConsumedAt).not.toBeNull();
    expect(w.conversations.conversations[0]!.currentIntentId).toBe(intent.intentId);
    expect(bound(w)).toEqual([expect.objectContaining({ targetId: intent.intentId, reasonCode: 'TEXT_MATCH' })]);
    expect(w.conversations.messages[0]!.text?.trim()).toBe(SENTENCE);
    expect(res.body.outbound_messages[0].text).toContain('Vitamin C Glow Serum');
  });

  it('an edited sentence binds nothing, and the chat still works from the product named in the text', async () => {
    const { w } = await world();
    await click(w, 'ws_plain_000001');
    const res = await say(w, 'shopper_1', "Hi! I'd like Vitamin C Glow Serum 30 ml, is it near Colaba?");
    expect(res.status).toBe(200);
    expect(res.body.decision.decision_source).toBe('AGENT');
    expect(intentOf(w, 'ws_plain_000001').tokenConsumedAt).toBeNull();
    expect(bound(w)).toEqual([]);
    expect(w.audit.brandEvents.filter((e) => e.action === 'INTENT_TOKEN_REJECTED')).toEqual([]);
  });

  it('two shoppers send the same sentence: the newest binds if issued within 2 minutes, else none', async () => {
    const recent = await world();
    await click(recent.w, 'ws_first_000001');
    recent.advance(5);
    await click(recent.w, 'ws_second_00001');
    recent.advance(1); // the second was issued 1 minute ago
    await say(recent.w, 'shopper_2', SENTENCE);
    expect(intentOf(recent.w, 'ws_second_00001').tokenConsumedAt).not.toBeNull();
    expect(intentOf(recent.w, 'ws_first_000001').tokenConsumedAt).toBeNull();

    const stale = await world();
    await click(stale.w, 'ws_first_000001');
    stale.advance(5);
    await click(stale.w, 'ws_second_00001');
    stale.advance(3); // the newest is 3 minutes old: no way to tell whose message this is
    await say(stale.w, 'shopper_3', SENTENCE);
    expect(stale.w.intents.intents.every((i) => i.tokenConsumedAt === null)).toBe(true);
    expect(stale.w.audit.brandEvents.filter((e) => e.action === 'INTENT_TOKEN_REJECTED')).toEqual([
      expect.objectContaining({ reasonCode: 'PREFILL_TEXT_AMBIGUOUS' }),
    ]);
  });

  it('expired or already used tokens never bind by text; tokens stay single-use', async () => {
    const expired = await world();
    await click(expired.w, 'ws_plain_000001');
    expired.advance(31);
    await say(expired.w, 'shopper_4', SENTENCE);
    expect(intentOf(expired.w, 'ws_plain_000001').tokenConsumedAt).toBeNull();

    const used = await world();
    await click(used.w, 'ws_plain_000001');
    await say(used.w, 'shopper_5', SENTENCE);
    const first = intentOf(used.w, 'ws_plain_000001').customerId;
    await say(used.w, 'shopper_6', SENTENCE); // someone else sends the same sentence afterwards
    expect(intentOf(used.w, 'ws_plain_000001').customerId).toBe(first);
    expect(bound(used.w)).toHaveLength(1);
  });

  it('another brand’s sentence never binds here; short messages are never looked up', async () => {
    const { w } = await world();
    await click(w, 'ws_brand_b_0001', 'brand_B');
    const sentenceB = (await click(w, 'ws_brand_b_0002', 'brand_B')).body.whatsapp.prefilled_text as string;
    await say(w, 'shopper_7', sentenceB); // sent to brand_A's chat
    expect(w.intents.intents.every((i) => i.tokenConsumedAt === null)).toBe(true);
    const listSpy = w.tokens.listOpenByTextHash.bind(w.tokens);
    let lookups = 0;
    w.tokens.listOpenByTextHash = async (...args) => {
      lookups++;
      return listSpy(...args);
    };
    await say(w, 'shopper_8', 'hi');
    expect(lookups).toBe(0);
  });

  it('an older message that still carries "(ref …)" binds as before', async () => {
    const { w } = await world();
    const res = await click(w, 'ws_plain_000001');
    await say(w, 'shopper_9', `Is it good for oily skin? ${refOf(res.body.whatsapp)}`);
    expect(intentOf(w, 'ws_plain_000001').tokenConsumedAt).not.toBeNull();
    expect(w.conversations.messages[0]!.text).toBe('Is it good for oily skin?');
    expect(bound(w)).toEqual([expect.objectContaining({ reasonCode: 'REF' })]);
  });
});
