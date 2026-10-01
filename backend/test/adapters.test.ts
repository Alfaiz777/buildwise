/**
 * Port contract suites (docs/08_TEST_PLAN.md §4). Each suite is written against
 * the PORT and takes an adapter factory, so the same suite runs against the real
 * gcp adapters in phase L2.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { MockCommerceProvider } from '../src/adapters/commerce/mockCommerceProvider.js';
import { LocalEventSink } from '../src/adapters/events/localEventSink.js';
import { SimulatorMessagingProvider } from '../src/adapters/messaging/simulatorMessagingProvider.js';
import { LocalFileStorageProvider } from '../src/adapters/storage/localFileStorageProvider.js';
import { decisionInput, stubExecutor } from './agentFixtures.js';
import type { CommerceEvent } from '../src/domain/events.js';
import { AgentDecisionSchema, type AgentRuntime, type DecisionInput } from '../src/ports/agent.js';
import type { CommerceProvider } from '../src/ports/commerce.js';
import type { EventSink } from '../src/ports/events.js';
import type { FileStorageProvider } from '../src/ports/fileStorage.js';
import type { MessagingProvider } from '../src/ports/messaging.js';

let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'buildwise-test-'));
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function commerceContract(name: string, make: () => CommerceProvider) {
  describe(`CommerceProvider contract — ${name}`, () => {
    it('returns products whose variants resolve by ID, with stable SKUs', async () => {
      const provider = make();
      const products = await provider.getProducts();
      expect(products.length).toBeGreaterThan(0);
      const variant = products[0]!.variants[0]!;
      expect(variant.sku).toBeTruthy();
      expect(await provider.getProductVariant(variant.externalVariantId)).toEqual(variant);
      expect(await provider.getProductVariant('gid://shopify/ProductVariant/unknown')).toBeNull();
    });

    it('carries product knowledge (tags / attributes) in the normalized shape', async () => {
      const [product] = await make().getProducts();
      expect(Array.isArray(product!.tags)).toBe(true);
      expect(typeof product!.attributes).toBe('object');
      expect(Object.values(product!.attributes).every((v) => typeof v === 'string')).toBe(true);
    });

    it('filters orders and inventory, and resolves customers and locations', async () => {
      const provider = make();
      const [order] = await provider.getOrders({});
      expect(order).toBeDefined();
      expect(await provider.getOrder(order!.externalOrderId)).toEqual(order);
      if (order!.externalCustomerId) {
        expect(await provider.getCustomer(order!.externalCustomerId)).not.toBeNull();
        expect(await provider.getOrders({ externalCustomerId: 'nobody' })).toEqual([]);
      }
      const locations = await provider.getLocations();
      expect(locations.length).toBeGreaterThan(0);
      const variantId = order!.lines[0]!.externalVariantId;
      const levels = await provider.getInventory({ externalVariantIds: [variantId] });
      expect(levels.every((l) => l.externalVariantId === variantId)).toBe(true);
    });

    it('returns copies: callers cannot mutate provider state', async () => {
      const provider = make();
      const [first] = await provider.getProducts();
      first!.title = 'mutated';
      expect((await provider.getProducts())[0]!.title).not.toBe('mutated');
    });
  });
}

function messagingContract(name: string, make: () => MessagingProvider, validRaw: unknown, customerRef: string) {
  describe(`MessagingProvider contract — ${name}`, () => {
    it('normalizes an inbound request into channel-neutral InboundMessages', () => {
      const provider = make();
      const [message] = provider.normalizeInbound(validRaw);
      expect(message).toMatchObject({ channel: provider.channel, externalCustomerRef: customerRef });
      expect(message!.externalMessageId).toBeTruthy();
    });

    it('rejects malformed inbound payloads', () => {
      expect(() => make().normalizeInbound({ nonsense: true })).toThrow();
    });

    it('sends an outbound message and reports the result', async () => {
      const result = await make().send({
        brandId: 'b',
        customerId: 'c',
        conversationId: 'conv',
        externalCustomerRef: customerRef,
        messageType: 'TEXT',
        text: 'hello',
        actionReference: null,
        outboundRequestId: 'out_1',
      });
      expect(['SENT', 'DELIVERED']).toContain(result.status);
      expect(result.externalMessageId).toBeTruthy();
    });
  });
}

function agentContract(name: string, make: () => AgentRuntime) {
  const input = (text: string): DecisionInput => decisionInput({ type: 'TEXT', text });

  describe(`AgentRuntime contract — ${name}`, () => {
    it('returns a valid AgentDecision tagged with its own runtime', async () => {
      const runtime = make();
      const decision = AgentDecisionSchema.parse(await runtime.decide(input('hello'), stubExecutor()));
      expect(decision.runtime).toBe(runtime.runtime);
    });

    it('hands off when the customer explicitly asks for a person', async () => {
      const decision = await make().decide(input('I want to talk to a person'), stubExecutor());
      expect(decision.next_best_action.action).toBe('HUMAN_HANDOFF');
    });
  });
}

function fileStorageContract(
  name: string,
  make: () => FileStorageProvider,
  put: (key: string, body: string) => Promise<void>,
) {
  describe(`FileStorageProvider contract — ${name}`, () => {
    it('issues a short-lived PUT upload target', async () => {
      const target = await make().createUploadTarget('retail/brd_1/upload.csv', 'text/csv', 10 * 1024 * 1024);
      expect(target.method).toBe('PUT');
      expect(target.headers['Content-Type']).toBe('text/csv');
      expect(new Date(target.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('reads and deletes stored files', async () => {
      const provider = make();
      await put('retail/brd_1/read-me.csv', 'store_id,sku\nA,1\n');
      const chunks: Buffer[] = [];
      for await (const chunk of await provider.openRead('retail/brd_1/read-me.csv')) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString('utf8')).toContain('store_id,sku');
      await provider.delete('retail/brd_1/read-me.csv');
      await expect(provider.openRead('retail/brd_1/read-me.csv')).rejects.toThrow();
    });

    it('writes server-side files that can be read back', async () => {
      const provider = make();
      await provider.write('retail/brd_1/report.json', '{"errors":[]}', 'application/json');
      const chunks: Buffer[] = [];
      for await (const chunk of await provider.openRead('retail/brd_1/report.json')) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString('utf8')).toBe('{"errors":[]}');
    });

    it.each(['../escape.csv', 'retail/../../etc/passwd', '/absolute.csv', 'retail//x.csv', 'a\\b.csv'])(
      'rejects unsafe key %s',
      async (key) => {
        await expect(make().openRead(key)).rejects.toThrow(/Invalid storage key/);
        await expect(make().createUploadTarget(key, 'text/csv', 10)).rejects.toThrow(/Invalid storage key/);
      },
    );
  });
}

function eventSinkContract(name: string, make: () => EventSink, readBack: () => Promise<string[]>) {
  const event = (id: string): CommerceEvent => ({
    eventId: id,
    brandId: 'brd_1',
    customerId: null,
    webSessionId: 'ws_1',
    eventType: 'PRODUCT_VIEW',
    source: 'WEBSITE',
    entityReference: null,
    eventPayloadReference: null,
    timestamp: '2026-10-01T10:00:00.000Z',
    idempotencyKey: `k_${id}`,
  });

  describe(`EventSink contract — ${name}`, () => {
    it('exports events and ignores empty batches', async () => {
      const sink = make();
      await sink.emit([]);
      await sink.emit([event('e1'), event('e2')]);
      const exported = await readBack();
      expect(exported.map((line) => JSON.parse(line).eventId)).toEqual(['e1', 'e2']);
    });
  });
}

commerceContract('MockCommerceProvider', () => new MockCommerceProvider());

messagingContract(
  'SimulatorMessagingProvider',
  () => new SimulatorMessagingProvider(),
  {
    brandId: 'brd_1',
    receivedAt: '2026-10-01T10:00:00.000Z',
    body: { simulator_customer_ref: 'customer_01', client_message_id: 'cm_1', content: { type: 'TEXT', text: 'hi' } },
  },
  'sim:customer_01',
);

describe('SimulatorMessagingProvider specifics', () => {
  it('normalizes location and interactive replies', () => {
    const provider = new SimulatorMessagingProvider();
    const base = { brandId: 'b', receivedAt: 'now', body: { simulator_customer_ref: 'c1', client_message_id: 'm' } };
    const [location] = provider.normalizeInbound({
      ...base,
      body: { ...base.body, content: { type: 'LOCATION', latitude: 19.07, longitude: 72.87 } },
    });
    expect(location!.content).toEqual({ type: 'LOCATION', latitude: 19.07, longitude: 72.87 });
    const [reply] = provider.normalizeInbound({
      ...base,
      body: { ...base.body, content: { type: 'INTERACTIVE_REPLY', option_id: 'reserve_A' } },
    });
    expect(reply!.content).toEqual({ type: 'INTERACTIVE_REPLY', optionId: 'reserve_A' });
  });

  it('refuses to deliver to a non-simulator identity', async () => {
    const result = await new SimulatorMessagingProvider().send({
      brandId: 'b',
      customerId: 'c',
      conversationId: 'x',
      externalCustomerRef: '919999999999',
      messageType: 'TEXT',
      text: 'hi',
      actionReference: null,
      outboundRequestId: 'o',
    });
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'NOT_A_SIMULATOR_CUSTOMER' });
  });
});

agentContract('MockAgentRuntime', () => new MockAgentRuntime());

describe('MockAgentRuntime specifics', () => {
  it('always identifies itself as MOCK, never as Gemini', async () => {
    const runtime = new MockAgentRuntime();
    expect(runtime.runtime).toBe('MOCK');
  });
});

describe('LocalFileStorageProvider upload receiver (local profile only)', () => {
  it('accepts one upload per target, stores it under the key, and expires targets', async () => {
    let now = new Date('2026-10-01T10:00:00.000Z');
    const provider = new LocalFileStorageProvider(dataDir, () => now);
    const target = await provider.createUploadTarget('retail/brd_1/up.csv', 'text/csv', 10);
    const uploadId = target.url.split('/').pop()!;
    expect(provider.describeUpload(uploadId)).toMatchObject({ key: 'retail/brd_1/up.csv', maxBytes: 10 });
    await expect(provider.acceptUpload(uploadId, Buffer.alloc(11))).rejects.toThrow(/size limit/);
    await provider.acceptUpload(uploadId, Buffer.from('a,b'));
    expect(provider.describeUpload(uploadId)).toBeNull();

    const expiring = await provider.createUploadTarget('retail/brd_1/late.csv', 'text/csv', 10);
    now = new Date('2026-10-01T11:00:00.000Z');
    expect(provider.describeUpload(expiring.url.split('/').pop()!)).toBeNull();
  });
});

fileStorageContract(
  'LocalFileStorageProvider',
  () => new LocalFileStorageProvider(dataDir),
  async (key, body) => {
    const path = join(dataDir, 'files', key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  },
);

eventSinkContract(
  'LocalEventSink',
  () => new LocalEventSink(join(dataDir, 'sink')),
  async () => {
    const dir = join(dataDir, 'sink', 'events');
    const files = await readdir(dir);
    expect(files).toEqual(['events-2026-10-01.jsonl']);
    return (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n');
  },
);
