/**
 * docs/08 §13 failure paths that can be reproduced locally (Change 14, G1–G2). Each one
 * fails gracefully and tells the person what to do next; nothing is half-written and
 * nothing is processed twice.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { MockCommerceProvider } from '../src/adapters/commerce/mockCommerceProvider.js';
import { SimulatorMessagingProvider } from '../src/adapters/messaging/simulatorMessagingProvider.js';
import type { CommerceProvider } from '../src/ports/commerce.js';
import type { MessagingProvider, OutboundMessage, SendResult } from '../src/ports/messaging.js';
import { bearer, buildTestWorld } from './helpers.js';
import { buildScenarioWorld } from './scenarioWorld.js';

const SYSTEM = { type: 'SYSTEM' as const, id: 'test' };

/** A commerce provider that is down until `up = true`. */
function flakyCommerce() {
  const real = new MockCommerceProvider();
  const state = { up: false };
  const provider = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...args: unknown[]) => {
        if (!state.up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as CommerceProvider;
  return { provider, state };
}

/** A simulator channel whose first `failures` sends fail with a retryable 5xx. */
function flakyChannel(failures: number) {
  const real = new SimulatorMessagingProvider();
  const calls: string[] = [];
  const provider: MessagingProvider = {
    channel: real.channel,
    verifyInbound: real.verifyInbound.bind(real),
    normalizeInbound: (raw) => real.normalizeInbound(raw),
    normalizeStatus: real.normalizeStatus.bind(real),
    async send(message: OutboundMessage): Promise<SendResult> {
      calls.push(message.outboundRequestId);
      if (calls.length <= failures) return { status: 'FAILED', externalMessageId: null, errorCode: 'HTTP_503' };
      return real.send(message);
    },
  };
  return { provider, calls };
}

describe('docs/08 §13 failure paths (local)', () => {
  it('commerce provider unavailable during sync → 502 with "Try again", the connection shows the error; retry succeeds', async () => {
    const { provider, state } = flakyCommerce();
    const world = buildTestWorld({ commerce: provider });
    const sync = () =>
      request(world.app).post('/api/integrations/shopify/sync').set('Authorization', bearer('admin_a'));
    const failed = await sync();
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ code: 'COMMERCE_SYNC_FAILED', retryable: true });
    expect(failed.body.error.message).toMatch(/Try again/);
    const connections = await request(world.app).get('/api/brand/connections').set('Authorization', bearer('admin_a'));
    expect(connections.body.connections[0]).toMatchObject({
      status: 'ERROR',
      last_error: { code: 'COMMERCE_SYNC_FAILED', message: 'The commerce provider could not be reached.' },
    });
    expect(JSON.stringify(connections.body)).not.toMatch(/ECONNREFUSED|stack/);
    state.up = true;
    const retried = await sync();
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'CONNECTED', last_error: null });
  });

  it('database unavailable mid-request → 503 SERVICE_UNAVAILABLE, a safe next step, no stack trace', async () => {
    const world = buildTestWorld();
    world.products.listProducts = async () => {
      throw Object.assign(new Error('14 UNAVAILABLE: No connection established at 10.0.0.1'), { code: 14 });
    };
    const res = await request(world.app).get('/api/products').set('Authorization', bearer('admin_a'));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
      message: "Qwikspot can't reach its database right now. Please try again in a minute.",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|10\.0\.0\.1|UNAVAILABLE:/);

    world.products.listProducts = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    };
    const crash = await request(world.app).get('/api/products').set('Authorization', bearer('admin_a'));
    expect(crash.status).toBe(500);
    expect(crash.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Something went wrong.',
      retryable: true,
      request_id: expect.any(String),
    });
  });

  it('a malformed retail file → a FAILED report with the reason and nothing half-written', async () => {
    const world = buildTestWorld();
    await world.commerceSync.sync('brand_A', SYSTEM);
    const storesBefore = world.stores.stores.length;
    const { record } = await world.retailImports.create('brand_A', SYSTEM, 'broken.csv');
    await world.files.write(record.fileKey, Buffer.from('store_id,store_name\nst_x,X\n'), 'text/csv');
    const report = await world.retailImports.process('brand_A', SYSTEM, record.importId);
    expect(report.record).toMatchObject({ status: 'FAILED', failureCode: 'MISSING_COLUMNS' });
    expect(world.stores.stores).toHaveLength(storesBefore);
    expect(world.inventory.rows).toEqual([]);
  });

  it('stale stock → the reply says when the store last updated its stock; the Retail Admin sees "stale"', async () => {
    const s = await buildScenarioWorld();
    for (const row of s.world.inventory.rows) row.lastUpdatedAt = '2026-10-05T04:00:00.000Z'; // ~50 h before the clock
    await s.startFromStore('c1', 'hi');
    const res = await s.share('c1');
    const text = res.body.outbound_messages[0].text as string;
    expect(text).toContain('Available today at *Colaba Store*\n2.0 km · open until 21:00');
    expect(text).toContain("Colaba Store's stock was last updated 5 Oct, 09:30 (store time), so it may have changed.");
    // The guardrail still re-verifies the numbers: a hold goes through on verified stock.
    const hold = await s.tap('c1', 'hold:sc_A');
    expect(hold.body.decision.executed_action.type).toBe('RESERVATION_CREATED');
    const stock = await s.get('/api/retail/stores/sc_A/inventory', 'radmin_scA');
    expect(stock.body.items.every((i: { stale: boolean }) => i.stale)).toBe(true);
    // Fresh stock is never qualified.
    const fresh = await buildScenarioWorld();
    for (const row of fresh.world.inventory.rows) row.lastUpdatedAt = '2026-10-07T05:00:00.000Z';
    await fresh.startFromStore('c1', 'hi');
    expect((await fresh.share('c1')).body.outbound_messages[0].text).not.toMatch(/last updated/);
  });

  it('outbound send fails twice → retried with the same request ID, then delivered', async () => {
    const { provider, calls } = flakyChannel(2);
    const s = await buildScenarioWorld({ simulatorProvider: provider });
    const res = await s.say('c1', 'Is this good for oily skin?');
    expect(res.body.outbound_messages[0].delivery_status).not.toBe('FAILED');
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(1);
  });

  it('outbound send keeps failing → FAILED delivery status, visible in the console', async () => {
    const { provider, calls } = flakyChannel(99);
    const s = await buildScenarioWorld({ simulatorProvider: provider });
    const res = await s.say('c1', 'Is this good for oily skin?');
    expect(res.status).toBe(200);
    expect(res.body.outbound_messages[0].delivery_status).toBe('FAILED');
    expect(calls).toHaveLength(3); // 1 + 2 retries
    const detail = await s.get(`/api/brand/conversations/${res.body.conversation_id}`);
    expect(detail.body.messages.at(-1)).toMatchObject({ direction: 'OUTBOUND', delivery_status: 'FAILED' });
  });

  it('a replay while the first delivery is still processing returns the original result; nothing runs twice', async () => {
    const s = await buildScenarioWorld({ agent: new MockAgentRuntime({ delayMs: 300 }) });
    const post = () =>
      request(s.world.app)
        .post('/api/channels/simulator/messages')
        .set('Authorization', bearer('admin_a'))
        .send({
          simulator_customer_ref: 'c9',
          client_message_id: 'same_id',
          content: { type: 'TEXT', text: 'Is this good for oily skin?' },
        });
    const [a, b] = await Promise.all([post(), post()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(s.world.recommendations.recommendations).toHaveLength(1);
    expect(s.world.conversations.messages.filter((m) => m.direction === 'INBOUND')).toHaveLength(1);
  });
});
