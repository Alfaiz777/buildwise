/**
 * L5: the demo brand's Ahmedabad store network — two areas (Satellite, Navrangpura), three
 * stores each. A customer names an area and gets that area's stores, nearest first, with the
 * nearest on the Pick up button; "Other stores" lists the area; a typed store name shows that
 * store's card (a hold needs one more tap); an area the brand does not serve gets the two areas.
 * Built on the real fixture (fixtures/retail/demo-retail.csv), through the real pipeline.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pickUpLabel } from '../src/domain/agentReplies.js';
import {
  AREA_GAZETTEER,
  namedShownStore,
  resolveLocality,
  servedAreas,
  type LocalityStore,
} from '../src/domain/locality.js';
import { WHATSAPP_LIMITS } from '../src/domain/whatsappLimits.js';
import { ahmedabadWorld, type SimulatorResponse } from './ahmedabadWorld.js';
import { bearer } from './helpers.js';

const ahmedabad = () => ahmedabadWorld();
type Res = SimulatorResponse;
const text = (res: Res) => res.body.outbound_messages[0].text as string;
const options = (res: Res) =>
  (res.body.outbound_messages[0].options ?? []) as { option_id: string; label: string; description?: string }[];
const ids = (res: Res) => options(res).map((o) => o.option_id);

const STORES: LocalityStore[] = [
  {
    storeId: 'st_north_1',
    storeName: 'Wellness Mart',
    city: 'Ahmedabad',
    address: 'Satellite Road',
    latitude: 23.0298,
    longitude: 72.5268,
    area: 'Satellite',
  },
  {
    storeId: 'st_north_2',
    storeName: 'HealthPlus Chemist',
    city: 'Ahmedabad',
    address: 'C.G. Road',
    latitude: 23.034,
    longitude: 72.5595,
    area: 'Navrangpura',
  },
];

describe('the area gazetteer', () => {
  it('area names and their aliases resolve to the area centre; the two areas come in gazetteer order', () => {
    expect(servedAreas(STORES).map((a) => a.name)).toEqual(['Satellite', 'Navrangpura']);
    for (const [say, area] of [
      ['near Satellite', 'Satellite'],
      ['I am in prahlad nagar', 'Satellite'],
      ['Shyamal cross road', 'Satellite'],
      ['CG road please', 'Navrangpura'],
      ['C.G. Road', 'Navrangpura'],
      ['near Law Garden today', 'Navrangpura'],
      ['ellisbridge', 'Navrangpura'],
    ] as const) {
      const r = resolveLocality(say, STORES);
      expect(r, say).toMatchObject({ status: 'MATCH', area, locality: area });
      if (r.status === 'MATCH') expect(r.origin).toEqual(AREA_GAZETTEER.find((g) => g.name === area)!.centre);
    }
  });

  it('a place the brand does not serve names the served areas; a store name is never an area; two areas are ambiguous', () => {
    expect(resolveLocality('I live in Bopal', STORES)).toEqual({
      status: 'UNSERVED',
      locality: 'bopal',
      served: ['Satellite', 'Navrangpura'],
    });
    expect(resolveLocality('Maninagar', STORES)).toMatchObject({ status: 'UNSERVED' });
    expect(resolveLocality('Wellness Mart', STORES)).toEqual({ status: 'NONE' });
    expect(resolveLocality('healthplus', STORES)).toEqual({ status: 'NONE' });
    expect(resolveLocality('Satellite or Navrangpura?', STORES)).toEqual({
      status: 'AMBIGUOUS',
      localities: ['Satellite', 'Navrangpura'],
    });
  });

  it('a typed store name is matched among the stores just shown — full, short or spaced — and only one', () => {
    const shown = [
      { store_id: 'st_sat_2', store_name: 'GlowUp Beauty', short_name: 'GlowUp' },
      { store_id: 'st_nav_2', store_name: 'Skin Studio', short_name: 'Skin Studio' },
      { store_id: 'st_north_2', store_name: 'HealthPlus Chemist', short_name: 'HealthPlus' },
    ];
    expect(namedShownStore("I'll go to GlowUp", shown)).toBe('st_sat_2');
    expect(namedShownStore('skin studio please', shown)).toBe('st_nav_2');
    expect(namedShownStore('Health Plus', shown)).toBe('st_north_2');
    expect(namedShownStore('is it good for oily skin?', shown)).toBeNull();
    expect(namedShownStore('GlowUp or HealthPlus?', shown)).toBeNull();
  });

  it('every short name fits a WhatsApp button as "Pick up: …"', () => {
    for (const short of ['Wellness', 'GlowUp', 'CityCare', 'HealthPlus', 'Skin Studio', 'MediGlow']) {
      const label = pickUpLabel({ store_name: 'x', short_name: short });
      expect(label).toBe(`Pick up: ${short}`);
      expect(label.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonLabel);
    }
  });
});

describe('the store card, Other stores and typed store names (real fixture, real pipeline)', () => {
  it('no location → "Which area?" with the two areas as buttons; Satellite → its 3 stores, nearest on the button', async () => {
    const s = await ahmedabad();
    const ask = await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today');
    expect(text(ask)).toBe(
      'Which area are you in for Vitamin C Glow Serum 30 ml? We have stores in Satellite and Navrangpura.',
    );
    expect(ids(ask)).toEqual(['area:Satellite', 'area:Navrangpura']);

    const card = await s.tap('c1', 'area:Satellite');
    expect(card.body.decision).toMatchObject({ action: 'STORE_DISCOVERY', decision_source: 'AGENT' });
    const lines = text(card).split('\n');
    expect(lines).toContain('In stock at 3 stores in Satellite:');
    const storeLines = lines.filter((l) => /^\d\. /.test(l));
    expect(storeLines.map((l) => /\*(.+?)\*/.exec(l)![1])).toEqual([
      'Wellness Mart',
      'GlowUp Beauty',
      'CityCare Pharmacy',
    ]);
    expect(storeLines[0]).toMatch(/^1\. \*Wellness Mart\*, Satellite Road · 0\.\d km · 6 in stock · open till 22:00$/);
    expect(storeLines[2]).toMatch(/· Only 2 left/);
    const km = storeLines.map((l) => Number(/· (\d+\.\d) km/.exec(l)![1]));
    expect([...km].sort((a, b) => a - b)).toEqual(km); // nearest first
    expect(text(card)).not.toMatch(/HealthPlus|MediGlow|Skin Studio/); // only this area's stores
    expect(options(card)[0]).toEqual({ option_id: 'hold:st_north_1', label: 'Pick up: Wellness' });
    expect(ids(card)).toContain('other_stores');
    expect(s.world.reservations.reservations).toEqual([]); // an offer, not a hold
  });

  it('Other stores lists every store of the area by full name, plus "Check another area"; a row holds there', async () => {
    const s = await ahmedabad();
    await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
    const list = await s.tap('c1', 'other_stores');
    expect(text(list)).toMatch(/^Stores in Satellite with \*Vitamin C Glow Serum 30 ml\* today/);
    const rows = options(list);
    expect(rows.map((r) => r.option_id)).toEqual([
      'hold:st_north_1',
      'hold:st_sat_2',
      'hold:st_sat_3',
      'buy_online',
      'areas',
    ]);
    expect(rows[1]).toMatchObject({
      label: 'GlowUp Beauty',
      description: expect.stringMatching(/^Shyamal Cross Road · \d\.\d km · 3 in stock$/),
    });
    for (const r of rows) {
      expect(r.label.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.rowTitle);
      expect((r.description ?? '').length).toBeLessThanOrEqual(WHATSAPP_LIMITS.rowDescription);
    }
    const hold = await s.tap('c1', 'hold:st_sat_3');
    expect(hold.body.decision).toMatchObject({ action: 'STORE_RESERVATION', guardrail_status: 'ALLOWED' });
    expect(s.world.reservations.reservations.map((r) => r.storeId)).toEqual(['st_sat_3']);

    const again = await s.tap('c2', 'areas'); // "Check another area"
    expect(ids(again)).toEqual(['area:Satellite', 'area:Navrangpura']);
  });

  it('typing a store name shows that store’s card and holds nothing; one more tap holds it there', async () => {
    const s = await ahmedabad();
    await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
    const named = await s.say('c1', "I'll go to GlowUp");
    expect(named.body.decision).toMatchObject({ action: 'STORE_DISCOVERY' });
    expect(text(named)).toMatch(/^\*Vitamin C Glow Serum 30 ml\* · ₹795\n🏬 \*GlowUp Beauty\*, Shyamal Cross Road · /);
    expect(text(named)).not.toMatch(/Wellness Mart|CityCare/);
    expect(options(named)[0]).toEqual({ option_id: 'hold:st_sat_2', label: 'Pick up: GlowUp' });
    expect(s.world.reservations.reservations).toEqual([]);

    // "hold it at GlowUp" never holds at the nearest store instead.
    const typedHold = await s.say('c1', 'hold it at GlowUp');
    expect(typedHold.body.decision).toMatchObject({ action: 'STORE_DISCOVERY' });
    expect(s.world.reservations.reservations).toEqual([]);

    const hold = await s.tap('c1', 'hold:st_sat_2');
    expect(hold.body.decision).toMatchObject({ action: 'STORE_RESERVATION', guardrail_status: 'ALLOWED' });
    expect(s.world.reservations.reservations.map((r) => r.storeId)).toEqual(['st_sat_2']);
  });

  it('typing the other area switches to it: Navrangpura lists only its stores in stock (none at Skin Studio)', async () => {
    const s = await ahmedabad();
    await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
    const nav = await s.say('c1', 'Navrangpura');
    expect(text(nav)).toContain('In stock at 2 stores in Navrangpura:');
    expect(text(nav)).toMatch(/1\. \*HealthPlus Chemist\*, C\.G\. Road · 0\.\d km · 5 in stock/);
    expect(text(nav)).toMatch(/2\. \*MediGlow Pharmacy\*/);
    expect(text(nav)).not.toMatch(/Skin Studio|Wellness|GlowUp|CityCare/);
    expect(options(nav)[0]).toEqual({ option_id: 'hold:st_north_2', label: 'Pick up: HealthPlus' });
  });

  it('an area the brand does not serve: "We have stores in Satellite and Navrangpura. Which is closer to you?"', async () => {
    const s = await ahmedabad();
    const res = await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today in Bopal');
    expect(text(res)).toBe('We have stores in Satellite and Navrangpura. Which is closer to you?');
    expect(ids(res)).toEqual(['area:Satellite', 'area:Navrangpura']);
    const card = await s.tap('c1', 'area:Navrangpura');
    expect(text(card)).toContain('in Navrangpura:');
  });

  it('a shared location picks the nearest area and lists only its stores', async () => {
    const s = await ahmedabad();
    await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today');
    const res = await s.share('c1', 23.0352, 72.5602); // C.G. Road
    expect(text(res)).toContain('in Navrangpura:');
    expect(text(res)).not.toMatch(/Wellness|GlowUp|CityCare/);
  });

  it('hold at Wellness Mart → its Retail Admin confirms, prepares and completes the pickup', async () => {
    const s = await ahmedabad();
    const wellness = s.world.stores.stores.find((x) => x.brandId === 'brand_A' && x.storeId === 'st_north_1')!;
    wellness.retailAdminUserId = 'radmin_wellness';
    s.world.users.users.push({
      userId: 'radmin_wellness',
      role: 'RETAIL_ADMIN',
      brandId: 'brand_A',
      retailerId: 'rtl_north',
      storeId: 'st_north_1',
      email: 'radmin_wellness@example.test',
      status: 'ACTIVE',
    });
    await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
    const hold = await s.tap('c1', 'hold:st_north_1');
    const id = hold.body.decision.executed_action.reservation_id as string;
    const reservation = () => s.world.reservations.reservations.find((r) => r.reservationId === id)!;
    const patch = (body: Record<string, unknown>) =>
      request(s.world.app).patch(`/api/reservations/${id}`).set('Authorization', bearer('radmin_wellness')).send(body);
    if (reservation().status === 'PENDING')
      expect((await patch({ status: 'CONFIRMED', expected_current_status: 'PENDING' })).status).toBe(200);
    expect((await patch({ status: 'READY', expected_current_status: 'CONFIRMED' })).status).toBe(200);
    expect((await patch({ status: 'CUSTOMER_ARRIVED', expected_current_status: 'READY' })).status).toBe(200);
    const done = await patch({
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: reservation().pickupCode,
    });
    expect(done.status).toBe(200);
    expect(reservation().status).toBe('COMPLETED');
  });

  it('a store refuses: the apology offers the area’s other stores, never the refusing one', async () => {
    const s = await ahmedabad();
    const wellness = s.world.stores.stores.find((x) => x.brandId === 'brand_A' && x.storeId === 'st_north_1')!;
    wellness.retailAdminUserId = 'radmin_wellness';
    s.world.users.users.push({
      userId: 'radmin_wellness',
      role: 'RETAIL_ADMIN',
      brandId: 'brand_A',
      retailerId: 'rtl_north',
      storeId: 'st_north_1',
      email: 'radmin_wellness@example.test',
      status: 'ACTIVE',
    });
    await s.say('c1', 'I need Vitamin C Glow Serum 30 ml today near Satellite');
    const hold = await s.tap('c1', 'hold:st_north_1');
    const id = hold.body.decision.executed_action.reservation_id as string;
    const refused = await request(s.world.app)
      .patch(`/api/reservations/${id}`)
      .set('Authorization', bearer('radmin_wellness'))
      .send({ status: 'CANCELLED', expected_current_status: 'PENDING', cancel_reason: 'DAMAGED' });
    expect(refused.status).toBe(200);
    const message = s.world.conversations.messages.filter((m) => m.origin === 'RESERVATION_UPDATE').at(-1)!;
    expect(message.text).toMatch(/^Sorry — Wellness Mart can't fulfil/);
    const holds = (message.options ?? []).map((o) => o.optionId).filter((o) => o.startsWith('hold:'));
    expect(holds[0]).toBe('hold:st_sat_2');
    expect(holds).not.toContain('hold:st_north_1');
    expect(s.world.conversations.conversations[0]!.pendingProposal?.offeredStores).not.toContain('st_north_1');
  });
});
