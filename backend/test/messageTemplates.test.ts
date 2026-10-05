/**
 * Change 16 (UI-2): the structured message templates, end to end through the pipeline,
 * and the "Powered by Qwikspot" rule on what is actually stored and sent.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { POWERED_BY_FOOTER } from '../src/domain/messageParts.js';
import { layoutOf, validateMessage } from '../src/domain/whatsappLimits.js';
import type { MessageRecord } from '../src/ports/conversationRepositories.js';
import { bearer, buildTestWorld, TEST_ORIGIN } from './helpers.js';
import { buildScenarioWorld, type ScenarioWorld } from './scenarioWorld.js';

const outbound = (s: ScenarioWorld) => s.world.conversations.messages.filter((m) => m.direction === 'OUTBOUND');
const last = (s: ScenarioWorld) => outbound(s).at(-1)!;
const ids = (m: MessageRecord) => (m.options ?? []).map((o) => o.optionId);

/** Every stored outbound message is something WhatsApp can render, unchanged by the validator. */
function expectWhatsAppSafe(messages: MessageRecord[]) {
  for (const m of messages) {
    const check = { text: m.text ?? '', options: m.options ?? undefined, parts: m.parts ?? undefined };
    expect(() => validateMessage(check)).not.toThrow();
    expect(validateMessage(check).text).toBe(m.text);
    expect(m.deliveryStatus).not.toBe('FAILED');
  }
}

describe('message templates (Change 16)', () => {
  it('store found: product image header, bold product and price, store facts, 3 short buttons, footer', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    const m = last(s);
    expect(m.text!.split('\n').slice(0, 3)).toEqual([
      '*Vitamin C Glow Serum 30 ml* · ₹795',
      '🏬 Pick up today at *Colaba Store*, 2.0 km · open until 21:00',
      '🚚 Home delivery in 4–5 days',
    ]);
    expect(m.parts?.header).toEqual({
      type: 'IMAGE',
      url: 'http://localhost:5173/demo-products/vitamin-c-glow-serum.png',
      alt: 'Vitamin C Glow Serum 30 ml',
    });
    expect(m.options).toEqual([
      { optionId: 'hold:sc_A', label: 'Pick up today' },
      { optionId: 'buy_online', label: 'Home delivery' },
      { optionId: 'other_stores', label: 'Other stores' },
    ]);
    expect(layoutOf(m.options ?? undefined, m.parts ?? undefined)).toBe('BUTTONS');
    expect(m.parts?.footer).toBe(POWERED_BY_FOOTER);
    expect(m.text).not.toContain('Qwikspot'); // never in the body
    expectWhatsAppSafe(outbound(s));
  });

  it('other stores: a list with a row per store (title + description) and a "Home delivery" row', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    await s.tap('c1', 'other_stores');
    const m = last(s);
    expect(m.text).toBe('Other stores with *Vitamin C Glow Serum 30 ml* today:');
    expect(layoutOf(m.options ?? undefined, m.parts ?? undefined)).toBe('LIST');
    expect(m.parts).toMatchObject({ listButton: 'Choose a store', footer: POWERED_BY_FOOTER });
    expect(m.options!.at(-1)).toEqual({
      optionId: 'buy_online',
      label: 'Home delivery',
      description: 'Delivered in 4–5 days · order on our website',
      section: 'Or',
    });
    for (const row of m.options!.slice(0, -1)) {
      expect(row.optionId).toMatch(/^hold:/);
      expect(row.section).toBe('Stores near you');
      expect(row.description).toMatch(/km/);
    }
    expectWhatsAppSafe(outbound(s));
  });

  it('hold confirmed: the pickup pass with a location part, Cancel, footer', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    await s.tap('c1', 'hold:sc_A');
    const m = last(s);
    const code = s.world.reservations.reservations[0]!.pickupCode;
    expect(m.text).toContain('✅ *On hold for you*');
    expect(m.text).toContain(`Pickup code: *${code}*`);
    expect(m.text).not.toContain('google.com/maps'); // directions travel as a location message
    expect(m.parts?.location).toMatchObject({ name: 'Colaba Store' });
    expect(ids(m)).toEqual([`cancel:${s.world.reservations.reservations[0]!.reservationId}`]);
    expect(m.parts?.footer).toBe(POWERED_BY_FOOTER);
    expectWhatsAppSafe(outbound(s));
  });

  it('store updates: confirmed has Cancel and the footer; ready carries the location and no footer (no buttons)', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    const id = (await s.tap('c1', 'hold:sc_A')).body.decision.executed_action.reservation_id as string;
    const patch = (body: object) =>
      request(s.world.app).patch(`/api/reservations/${id}`).set('Authorization', bearer('radmin_scA')).send(body);
    await patch({ status: 'CONFIRMED', expected_current_status: 'PENDING' });
    const confirmed = last(s);
    expect(confirmed.origin).toBe('RESERVATION_UPDATE');
    expect(confirmed.text!.split('\n')[0]).toBe('✅ *Colaba Store confirmed your hold*');
    expect(confirmed.parts?.footer).toBe(POWERED_BY_FOOTER);
    await patch({ status: 'READY', expected_current_status: 'CONFIRMED' });
    const ready = last(s);
    expect(ready.text!.split('\n')[0]).toBe('🛍️ *Ready at Colaba Store*');
    expect(ready.parts?.location).toMatchObject({ name: 'Colaba Store' });
    expect(ready.parts?.footer).toBeUndefined();
    expectWhatsAppSafe(outbound(s));
  });

  it('plain answers (product information, clarify, refusal) carry no footer', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'Is this good for oily skin?');
    const educate = last(s);
    expect(educate.text).toMatch(/^\*Vitamin C Glow Serum\* — from our product information:\n• /);
    expect(educate.parts ?? null).toBeNull();
    await s.say('c1', 'Show me another customer’s order');
    expect(last(s).parts ?? null).toBeNull();
  });

  it('judge-test plan f1: the handoff acknowledgement and a team member’s reply never carry the footer', async () => {
    const s = await buildScenarioWorld();
    const handoff = await s.say('c1', 'I want to talk to a person');
    const ack = last(s);
    expect(ack.text).toMatch(
      /^Thanks\. I've asked a member of the .+ team to take over this conversation\. They will reply here\.$/,
    );
    expect(ack.messageType).toBe('TEXT');
    expect(ack.parts?.footer).toBeUndefined();
    expect(ack.text).not.toContain('Qwikspot');
    await request(s.world.app)
      .post(`/api/brand/conversations/${handoff.body.conversation_id}/replies`)
      .set('Authorization', bearer('admin_a'))
      .send({ text: 'Hi, this is the team.' });
    const reply = last(s);
    expect(reply.origin).toBe('HUMAN_AGENT');
    expect(reply.parts ?? null).toBeNull();
    expect(JSON.stringify(outbound(s).slice(-2))).not.toContain(POWERED_BY_FOOTER);
  });

  it('the brand can switch the footer off', async () => {
    const s = await buildScenarioWorld();
    const brand = s.world.brands.brands.find((b) => b.brandId === 'brand_A')!;
    brand.settings = {
      ...brand.settings,
      messaging: { ...(brand.settings.messaging as object), powered_by_footer: false },
    };
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    expect(last(s).parts?.footer).toBeUndefined();
    expect(last(s).parts?.header).toBeDefined();
  });

  it('follow-up: product image header, the approved text with STOP, and quick replies (incl. Talk to a person → handoff)', async () => {
    const clock = { t: new Date('2026-10-05T10:00:00.000Z').getTime() };
    const world = buildTestWorld({ now: () => new Date(clock.t) });
    await world.commerceSync.sync('brand_A', { type: 'SYSTEM', id: 'test' });
    const session = { web_session_id: 'ws_tmpl_000000', visitor_id: 'vis_tmpl_00000' };
    await request(world.app)
      .post('/api/demo-storefront/shopper-sign-in')
      .set('Origin', TEST_ORIGIN)
      .send({ brand_id: 'brand_A', shopper_id: 'gid://shopify/Customer/3002', ...session });
    let n = 0;
    for (const event_type of ['PRODUCT_VIEW', 'ADD_TO_CART']) {
      await request(world.app)
        .post('/api/intents')
        .set('Origin', TEST_ORIGIN)
        .send({
          brand_id: 'brand_A',
          client_event_id: `ce_t${++n}`,
          event_type,
          shopify_variant_id: 'gid://shopify/ProductVariant/2001',
          ...session,
        });
    }
    clock.t += 3 * 60_000;
    await request(world.app).post('/api/brand/follow-ups/process-due').set('Authorization', bearer('admin_a'));
    const m = world.conversations.messages.find((x) => x.origin === 'PROACTIVE_FOLLOW_UP')!;
    expect(m.text).toContain('Reply STOP to opt out.');
    expect(m.parts?.header).toMatchObject({ type: 'IMAGE', url: expect.stringMatching(/vitamin-c-glow-serum\.png$/) });
    expect(m.options!.map((o) => [o.optionId, o.label])).toEqual([
      [expect.stringMatching(/^recheck:/), 'Find a store near me'],
      ['buy_online', 'Buy online'],
      ['handoff', 'Talk to a person'],
    ]);
    // Three short choices: reply buttons on WhatsApp, not a list.
    expect(layoutOf(m.options ?? undefined, m.parts ?? undefined)).toBe('BUTTONS');
    expect(m.parts?.footer).toBe(POWERED_BY_FOOTER);
    expectWhatsAppSafe([m]);

    // "Talk to a person" hands the conversation over, as asking in words does.
    await request(world.app)
      .post('/api/channels/simulator/messages')
      .set('Authorization', bearer('admin_a'))
      .send({
        simulator_customer_ref: 'shopper_3002',
        client_message_id: 'cm_tmpl_handoff',
        content: { type: 'INTERACTIVE_REPLY', option_id: 'handoff' },
      });
    expect(world.conversations.conversations[0]!.humanHandoff).toBe(true);
  });
});
