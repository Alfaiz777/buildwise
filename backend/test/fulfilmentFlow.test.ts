/**
 * M6 through the real routes and pipeline on the in-memory world: the store queue and
 * transitions, customer notifications (incl. refusal forward dispatch), outcomes, bw_ref
 * attribution and the handoff queue. Stores A–E per docs/08 §7.1; sc_A and sc_B belong to
 * retailer rtl_A with one Retail Admin each.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, TEST_ORIGIN } from './helpers.js';
import { buildScenarioWorld, V1, V2, type ScenarioWorld } from './scenarioWorld.js';

const patch = (s: ScenarioWorld, user: string, id: string, body: Record<string, unknown>) =>
  request(s.world.app).patch(`/api/reservations/${id}`).set('Authorization', bearer(user)).send(body);

async function held(s: ScenarioWorld, ref = 'c1', store = 'sc_A') {
  await s.startFromStore(ref, 'hi');
  await s.share(ref);
  const hold = await s.tap(ref, `hold:${store}`);
  expect(hold.body.decision.executed_action?.type).toBe('RESERVATION_CREATED');
  const id = hold.body.decision.executed_action.reservation_id as string;
  return { id, pickupCode: s.world.reservations.reservations.find((r) => r.reservationId === id)!.pickupCode };
}

const updates = (s: ScenarioWorld) =>
  s.world.conversations.messages.filter((m) => m.origin === 'RESERVATION_UPDATE').map((m) => m.text ?? '');

describe('store queue and transitions (Change 13, F1–F2)', () => {
  it('confirm → ready → arrived → complete with the right code: notified each step, OFFLINE outcome, stock drops', async () => {
    const s = await buildScenarioWorld();
    const { id, pickupCode } = await held(s);

    const queue = await s.get('/api/reservations?view=active', 'radmin_scA');
    expect(queue.body.reservations).toEqual([
      expect.objectContaining({
        reservation_id: id,
        status: 'PENDING',
        store_timezone: 'Asia/Kolkata',
        allowed_actions: ['CONFIRMED', 'CANCELLED'],
        customer_display: expect.stringMatching(/^Customer •••• /),
      }),
    ]);
    expect(JSON.stringify(queue.body)).not.toMatch(/sim:c1|pickup_code"/);

    const confirmed = await patch(s, 'radmin_scA', id, { status: 'CONFIRMED', expected_current_status: 'PENDING' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: 'CONFIRMED',
      notification: { status: 'SENT', event: 'CONFIRMED', message_kind: 'SESSION' },
    });
    expect(updates(s).at(-1)).toBe(
      `Colaba Store has confirmed your reservation for Vitamin C Glow Serum 30 ml. Pickup code ${pickupCode}, held until 14:00 (store time).`,
    );

    await patch(s, 'radmin_scA', id, { status: 'READY', expected_current_status: 'CONFIRMED' });
    expect(updates(s).at(-1)).toMatch(
      new RegExp(
        `^Your Vitamin C Glow Serum 30 ml is ready at Colaba Store\\. Show code ${pickupCode}\\. Directions: https://www\\.google\\.com/maps/`,
      ),
    );
    await patch(s, 'radmin_scA', id, { status: 'CUSTOMER_ARRIVED', expected_current_status: 'READY' });
    const done = await patch(s, 'radmin_scA', id, {
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: pickupCode,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', allowed_actions: [], notification: null });
    expect(s.stock('sc_A')).toMatchObject({ quantity: 7, reservedQuantity: 0 });

    expect(s.world.outcomes.outcomes).toEqual([
      expect.objectContaining({
        purchaseType: 'OFFLINE',
        evidence: 'RESERVATION_COMPLETED',
        storeId: 'sc_A',
        reservationId: id,
        variantId: V1,
        value: 795,
        channel: 'SIMULATOR',
        journeyKey: expect.stringMatching(/^int:/),
        aiRecommendationId: expect.stringMatching(/^rec_/),
      }),
    ]);
    const types = s.world.events.events.map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining(['RESERVATION_CONFIRMED', 'PICKUP_COMPLETED', 'OFFLINE_PURCHASE', 'OUTCOME_RECORDED']),
    );
    expect(s.world.audit.brandEvents.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'RESERVATION_CONFIRMED',
        'RESERVATION_READY',
        'RESERVATION_COMPLETED',
        'OUTCOME_RECORDED',
      ]),
    );
  });

  it('wrong pickup code → 422, audited, nothing changes; locked from the 5th wrong attempt (429)', async () => {
    const s = await buildScenarioWorld();
    const { id, pickupCode } = await held(s);
    for (const [from, to] of [
      ['PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'READY'],
      ['READY', 'CUSTOMER_ARRIVED'],
    ])
      await patch(s, 'radmin_scA', id, { status: to, expected_current_status: from });
    const wrong = pickupCode === '000000' ? '111111' : '000000';
    const attempt = () =>
      patch(s, 'radmin_scA', id, {
        status: 'COMPLETED',
        expected_current_status: 'CUSTOMER_ARRIVED',
        pickup_code: wrong,
      });
    const first = await attempt();
    expect(first.status).toBe(422);
    expect(first.body.error.code).toBe('PICKUP_CODE_MISMATCH');
    expect(s.world.reservations.reservations[0]).toMatchObject({ status: 'CUSTOMER_ARRIVED', pickupCodeAttempts: 1 });
    expect(s.stock('sc_A')).toMatchObject({ quantity: 8, reservedQuantity: 1 });
    expect(s.world.audit.brandEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'PICKUP_CODE_REJECTED', reasonCode: 'PICKUP_CODE_MISMATCH' }),
      ]),
    );
    for (let i = 0; i < 4; i++) await attempt();
    const locked = await patch(s, 'radmin_scA', id, {
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: pickupCode,
    });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('PICKUP_CODE_LOCKED');
    expect(s.world.outcomes.outcomes).toEqual([]);
  });

  it('409 STALE_STATUS and INVALID_TRANSITION; a missing reason or code → 400', async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    const stale = await patch(s, 'radmin_scA', id, { status: 'READY', expected_current_status: 'CONFIRMED' });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'STALE_STATUS']);
    const invalid = await patch(s, 'radmin_scA', id, { status: 'READY', expected_current_status: 'PENDING' });
    expect([invalid.status, invalid.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    const expire = await patch(s, 'radmin_scA', id, { status: 'EXPIRED', expected_current_status: 'PENDING' });
    expect(expire.status).toBe(409);
    expect((await patch(s, 'radmin_scA', id, { status: 'CANCELLED', expected_current_status: 'PENDING' })).status).toBe(
      400,
    );
    expect((await patch(s, 'radmin_scA', id, { status: 'COMPLETED', expected_current_status: 'PENDING' })).status).toBe(
      400,
    );
  });

  it('scope: another store of the same retailer → 404; BRAND_ADMIN and PLATFORM_ADMIN → 403; another brand → 404', async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    const body = { status: 'CONFIRMED', expected_current_status: 'PENDING' };
    expect((await patch(s, 'radmin_scB', id, body)).status).toBe(404);
    expect((await s.get(`/api/reservations/${id}`, 'radmin_scB')).status).toBe(404);
    expect((await patch(s, 'admin_a', id, body)).status).toBe(403);
    expect((await patch(s, 'platform', id, body)).status).toBe(403);
    expect((await s.get(`/api/reservations/${id}`, 'admin_b')).status).toBe(404);
    expect((await s.get(`/api/reservations/${id}`, 'admin_a')).status).toBe(200); // brand: view only
    expect((await s.get(`/api/reservations/${id}`, 'radmin_scA')).body.status).toBe('PENDING');
    expect(s.world.reservations.reservations[0]!.status).toBe('PENDING');
  });

  it('This week strip: own store only', async () => {
    const s = await buildScenarioWorld();
    await held(s);
    expect((await s.get('/api/retail/stores/sc_A/summary', 'radmin_scA')).body).toEqual({
      days: 7,
      reservations: 1,
      completed: 0,
      refused: 0,
      expired: 0,
    });
    expect((await s.get('/api/retail/stores/sc_B/summary', 'radmin_scA')).status).toBe(404);
  });
});

describe('refusal with forward dispatch (Change 13, F3–F4)', () => {
  it('NOT_ACTUALLY_IN_STOCK: apology + hold at the next eligible store (never the refusing one); stock corrected; the tap reserves there', async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    const refused = await patch(s, 'radmin_scA', id, {
      status: 'CANCELLED',
      expected_current_status: 'PENDING',
      cancel_reason: 'NOT_ACTUALLY_IN_STOCK',
    });
    expect(refused.body).toMatchObject({
      status: 'CANCELLED',
      cancelled_by: 'RETAILER',
      cancel_reason: 'NOT_ACTUALLY_IN_STOCK',
      notification: { status: 'SENT', event: 'REFUSED' },
    });
    expect(s.stock('sc_A')).toMatchObject({ quantity: 0, reservedQuantity: 0 }); // unavailable there now
    expect(s.world.audit.brandEvents.map((a) => a.action)).toContain('INVENTORY_CORRECTED_BY_RETAILER');

    const message = s.world.conversations.messages.filter((m) => m.origin === 'RESERVATION_UPDATE').at(-1)!;
    expect(message.text).toMatch(
      /^Sorry — Colaba Store can't fulfil your reservation for Vitamin C Glow Serum 30 ml after all\./,
    );
    expect(message.text).not.toMatch(/NOT_ACTUALLY|stock count|not actually/i);
    const offered = message.options!.map((o) => o.optionId);
    expect(offered[0]).toBe('hold:sc_E');
    expect(offered).not.toContain('hold:sc_A');
    expect(s.world.conversations.conversations[0]!.pendingProposal).toMatchObject({ storeId: 'sc_E', variantId: V1 });
    expect(s.world.reservations.reservations).toHaveLength(1); // nothing reserved without the tap

    const tap = await s.tap('c1', 'hold:sc_E');
    expect(tap.body.decision.executed_action.type).toBe('RESERVATION_CREATED');
    expect(s.world.reservations.reservations.at(-1)).toMatchObject({ storeId: 'sc_E', status: 'PENDING' });
  });

  it('no other store qualifies → online / alternative and UNMET_DEMAND; OTHER notes never reach the customer', async () => {
    const s = await buildScenarioWorld({
      overrides: { sc_B: { v1: 0 }, sc_C: { v1: 0 }, sc_E: { v1: 0 } },
    });
    const { id } = await held(s);
    for (const row of s.world.inventory.rows) if (row.variantId === V2) row.quantity = 0;
    await patch(s, 'radmin_scA', id, {
      status: 'CANCELLED',
      expected_current_status: 'PENDING',
      cancel_reason: 'OTHER',
      cancel_note: 'till broken, ask Priya',
    });
    const message = s.world.conversations.messages.filter((m) => m.origin === 'RESERVATION_UPDATE').at(-1)!;
    expect(message.text).toContain("isn't available for pickup at a store near you right now");
    expect(message.text).toMatch(/http:\/\/shop\.test\/products\/prd_1001\?bw_ref=/);
    expect(message.text).not.toMatch(/till|Priya/);
    expect(message.options!.map((o) => o.optionId)).toEqual(['buy_online']);
    const unmet = s.world.events.events.find(
      (e) => e.eventType === 'STORE_RECOMMENDATION' && e.payload.kind === 'UNMET_DEMAND',
    );
    expect(unmet?.payload).toMatchObject({ variant_id: V1 });
    expect(s.world.reservations.reservations[0]).toMatchObject({ cancelNote: 'till broken, ask Priya' });
  });

  it('an opted-out customer is not notified, and the store sees it', async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    await s.say('c1', 'STOP');
    const before = updates(s).length;
    const res = await patch(s, 'radmin_scA', id, { status: 'CONFIRMED', expected_current_status: 'PENDING' });
    expect(res.body.notification).toMatchObject({ status: 'NOT_SENT_OPTED_OUT' });
    expect(updates(s)).toHaveLength(before);
    expect(
      (await s.get('/api/reservations?view=active', 'radmin_scA')).body.reservations[0].last_notification,
    ).toMatchObject({
      status: 'NOT_SENT_OPTED_OUT',
      event: 'CONFIRMED',
    });
  });

  it('while a person owns the conversation, the refusal apology is sent without the automated re-offer', async () => {
    const s = await buildScenarioWorld();
    const { id } = await held(s);
    await s.say('c1', 'I want to talk to a person');
    await patch(s, 'radmin_scA', id, {
      status: 'CANCELLED',
      expected_current_status: 'PENDING',
      cancel_reason: 'DAMAGED',
    });
    const message = s.world.conversations.messages.filter((m) => m.origin === 'RESERVATION_UPDATE').at(-1)!;
    expect(message.options).toBeNull();
    expect(message.text).toMatch(/^Sorry — Colaba Store can't fulfil/);
  });
});

describe('outcomes: expiry, NONE window, first purchase wins (Change 13, F5)', () => {
  it('a hold expires: the customer is told; NONE only after the attribution window, then never twice', async () => {
    const s = await buildScenarioWorld();
    const brand = s.world.brands.brands.find((b) => b.brandId === 'brand_A')!;
    brand.settings = { ...brand.settings, outcome_policy: { attribution_window_minutes: 60 } };
    await held(s);
    const due = () =>
      request(s.world.app).post('/api/brand/follow-ups/process-due').set('Authorization', bearer('admin_a'));
    s.advanceMinutes(121);
    expect((await due()).body).toMatchObject({ reservations_expired: 1, outcomes_closed: 0 });
    expect(updates(s).at(-1)).toBe('Your hold at Colaba Store for Vitamin C Glow Serum 30 ml has expired.');
    expect(s.world.outcomes.outcomes).toEqual([]); // the customer may still buy online
    s.advanceMinutes(30); // the window counts from when the hold ended, not from the offer
    expect((await due()).body.outcomes_closed).toBe(0);
    s.advanceMinutes(30);
    expect((await due()).body.outcomes_closed).toBe(1);
    expect(s.world.outcomes.outcomes).toEqual([
      expect.objectContaining({ purchaseType: 'NONE', evidence: 'WINDOW_CLOSED', value: 0 }),
    ]);
    expect((await due()).body.outcomes_closed).toBe(0);

    // The "Check stores again" tap is a fresh search for the same variant.
    const recheck = await s.tap('c1', `recheck:${V1}`);
    expect(recheck.body.decision.action).toBe('STORE_DISCOVERY');
  });

  it('buy online → bw_ref → order → ONLINE outcome linked to the recommendation; a second order adds no Outcome', async () => {
    const s = await buildScenarioWorld();
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    const online = await s.tap('c1', 'buy_online');
    const ref = /bw_ref=([0-9A-Z]{26})/.exec(online.body.outbound_messages[0].text)![1]!;
    expect(s.world.attributionRefs.refs).toHaveLength(1);
    expect(s.world.attributionRefs.refs[0]!.refHash).not.toContain(ref);
    const order = (bw: string | undefined, session: string) =>
      request(s.world.app)
        .post('/api/demo-storefront/orders')
        .set('Origin', TEST_ORIGIN)
        .send({
          brand_id: 'brand_A',
          web_session_id: session,
          shopify_variant_id: 'gid://shopify/ProductVariant/2001',
          ...(bw ? { bw_ref: bw } : {}),
        });
    const first = await order(ref, 'ws_other_tab_000001');
    expect(first.body).toMatchObject({ attributed: true, outcome_recorded: true });
    expect(s.world.outcomes.outcomes).toEqual([
      expect.objectContaining({
        purchaseType: 'ONLINE',
        evidence: 'ORDER',
        aiRecommendationId: online.body.decision.recommendation_id,
        value: 795,
      }),
    ]);
    const second = await order(ref, 'ws_other_tab_000002');
    expect(second.body).toMatchObject({ attributed: true, outcome_recorded: false });
    expect(s.world.outcomes.outcomes).toHaveLength(1);
    expect(s.world.events.events.filter((e) => e.eventType === 'ORDER_CREATED')).toHaveLength(2);

    const bogus = await order('0123456789ABCDEFGHJKMNPQRS', 'ws_other_tab_000003');
    expect(bogus.status).toBe(201);
    expect(bogus.body).toMatchObject({ attributed: false, outcome_recorded: false });
  });

  it('an alternative held and completed → ALTERNATIVE (different variant than the intent)', async () => {
    const s = await buildScenarioWorld({
      overrides: { sc_A: { v1: 0 }, sc_B: { v1: 0 }, sc_C: { v1: 0 }, sc_E: { v1: 0 } },
    });
    await s.startFromStore('c1', 'hi');
    await s.share('c1');
    const hold = await s.tap('c1', 'hold:sc_A');
    const id = hold.body.decision.executed_action.reservation_id;
    const r = s.world.reservations.reservations[0]!;
    expect(r.variantId).toBe(V2);
    for (const [from, to] of [
      ['PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'READY'],
      ['READY', 'CUSTOMER_ARRIVED'],
    ])
      await patch(s, 'radmin_scA', id, { status: to, expected_current_status: from });
    await patch(s, 'radmin_scA', id, {
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: r.pickupCode,
    });
    expect(s.world.outcomes.outcomes[0]).toMatchObject({ purchaseType: 'ALTERNATIVE', variantId: V2, value: 649 });
  });
});

describe('handoff queue (Change 13, F7)', () => {
  it('reply as a person (HUMAN_AGENT, uid only in audit) → resolve → the next message gets an automated reply', async () => {
    const s = await buildScenarioWorld();
    const handoff = await s.say('c1', 'I want to talk to a person');
    const conv = handoff.body.conversation_id;
    const list = await s.get('/api/brand/conversations');
    expect(list.body.conversations[0]).toMatchObject({ human_handoff: true, handoff_at: expect.any(String) });

    const post = (path: string, user = 'admin_a', body: object = {}) =>
      request(s.world.app)
        .post(`/api/brand/conversations/${conv}/${path}`)
        .set('Authorization', bearer(user))
        .send(body);
    const reply = await post('replies', 'admin_a', { text: 'Hi, this is Meera from the team. How can I help?' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ origin: 'HUMAN_AGENT', direction: 'OUTBOUND' });
    expect(JSON.stringify(reply.body)).not.toContain('admin_a');
    expect(s.world.audit.brandEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'HUMAN_REPLY_SENT', actorId: 'admin_a' })]),
    );
    expect((await s.say('c1', 'ok thanks')).body.outbound_messages).toEqual([]); // still with the person

    expect((await post('replies', 'admin_b', { text: 'x' })).status).toBe(404);
    expect((await post('resolve', 'radmin_scA')).status).toBe(403);
    expect((await post('resolve')).body).toEqual({ human_handoff: false });
    expect((await post('replies', 'admin_a', { text: 'more' })).body.error.code).toBe('NOT_IN_HANDOFF');
    const back = await s.say('c1', 'Is this good for oily skin?');
    expect(back.body.outbound_messages).toHaveLength(1);
    expect(back.body.decision.decision_source).toBe('AGENT');
  });

  it('opted-out and outside-the-window replies are refused', async () => {
    const s = await buildScenarioWorld();
    const conv = (await s.say('c1', 'I want to talk to a person')).body.conversation_id;
    const reply = () =>
      request(s.world.app)
        .post(`/api/brand/conversations/${conv}/replies`)
        .set('Authorization', bearer('admin_a'))
        .send({ text: 'hello' });
    s.advanceMinutes(25 * 60);
    expect((await reply()).body.error.code).toBe('OUTSIDE_SERVICE_WINDOW');
    await s.say('c1', 'STOP');
    expect((await reply()).body.error.code).toBe('CUSTOMER_OPTED_OUT');
  });
});
