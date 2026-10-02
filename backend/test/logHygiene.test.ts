/**
 * Log hygiene across the whole customer + store journey (docs/07 §11): every log line is
 * captured and searched. Logs carry IDs and codes — never contact details, intent tokens,
 * pickup codes, qs_ref values or message text.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { bearer, TEST_ORIGIN } from './helpers.js';
import { buildScenarioWorld } from './scenarioWorld.js';

describe('log hygiene (docs/07 §11)', () => {
  it('a full journey logs no PII, tokens, pickup codes, qs_ref values or message text', async () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (line) => lines.push(line));
    const s = await buildScenarioWorld({ logger });

    // Customer: storefront handshake → location → hold.
    const first = await s.startFromStore('c1', 'I need it today');
    await s.share('c1');
    const hold = await s.tap('c1', 'hold:sc_A');
    const reservationId = hold.body.decision.executed_action.reservation_id as string;
    const pickupCode = s.world.reservations.reservations[0]!.pickupCode;

    // Store: confirm → ready → arrived → a wrong code → the right code.
    const patch = (body: object) =>
      request(s.world.app)
        .patch(`/api/reservations/${reservationId}`)
        .set('Authorization', bearer('radmin_scA'))
        .send(body);
    await patch({ status: 'CONFIRMED', expected_current_status: 'PENDING' });
    await patch({ status: 'READY', expected_current_status: 'CONFIRMED' });
    await patch({ status: 'CUSTOMER_ARRIVED', expected_current_status: 'READY' });
    await patch({
      status: 'COMPLETED',
      expected_current_status: 'CUSTOMER_ARRIVED',
      pickup_code: pickupCode === '000000' ? '111111' : '000000',
    });
    await patch({ status: 'COMPLETED', expected_current_status: 'CUSTOMER_ARRIVED', pickup_code: pickupCode });

    // Buy online with a qs_ref, a demo shopper sign-in and an attributed order.
    await s.startFromStore('c2', 'hi');
    await s.share('c2');
    const online = await s.tap('c2', 'buy_online');
    const ref = /qs_ref=([0-9A-Z]{26})/.exec(online.body.outbound_messages[0].text)![1]!;
    await request(s.world.app).post('/api/demo-storefront/shopper-sign-in').set('Origin', TEST_ORIGIN).send({
      brand_id: 'brand_A',
      shopper_id: 'gid://shopify/Customer/3002',
      web_session_id: 'ws_log_00000001',
      visitor_id: 'vis_log_0000001',
    });
    await request(s.world.app).post('/api/demo-storefront/orders').set('Origin', TEST_ORIGIN).send({
      brand_id: 'brand_A',
      web_session_id: 'ws_log_00000001',
      shopify_variant_id: 'gid://shopify/ProductVariant/2001',
      qs_ref: ref,
    });

    // Handoff + a reply as a person + opt-out + an invalid token + due work.
    const handoff = await s.say('c3', 'I want to talk to a person');
    await request(s.world.app)
      .post(`/api/brand/conversations/${handoff.body.conversation_id}/replies`)
      .set('Authorization', bearer('admin_a'))
      .send({ text: 'Hello from Meera at the brand' });
    await s.say('c4', 'START_QWIKSPOT_0123456789ABCDEFGHJKMNPQRS hello');
    await s.say('c4', 'STOP');
    await request(s.world.app).post('/api/brand/follow-ups/process-due').set('Authorization', bearer('admin_a'));

    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThanOrEqual(20); // the access log really was captured
    expect(log).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // emails
    expect(log).not.toMatch(/\+91|\b\d{10}\b/); // phone numbers
    expect(log).not.toMatch(/Asha|Ravi|Meera/); // demo shopper / person names
    expect(log).not.toMatch(/START_QWIKSPOT_|[0-9A-HJKMNP-TV-Z]{26}/); // intent tokens and qs_ref values
    expect(log).not.toContain(ref);
    expect(log).not.toMatch(new RegExp(`\\b${pickupCode}\\b`));
    // No message text, inbound or outbound.
    const texts = s.world.conversations.messages.map((m) => m.text).filter((t): t is string => !!t && t.length > 12);
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect(log).not.toContain(text.slice(0, 40));
    expect(first.status).toBe(200);
  });
});
