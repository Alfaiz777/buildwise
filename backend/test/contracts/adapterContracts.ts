/**
 * Port contract suites (docs/08_TEST_PLAN.md §4; Change 14 G6). Each suite is written
 * against the PORT and takes an adapter factory, so the SAME suite runs against the local
 * adapters now (test/adapters.test.ts) and the real gcp adapters in phase L2, unchanged.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decisionInput, stubExecutor } from '../agentFixtures.js';
import type { CommerceEvent } from '../../src/domain/events.js';
import { AgentDecisionSchema, type AgentRuntime, type DecisionInput } from '../../src/ports/agent.js';
import type { CommerceProvider } from '../../src/ports/commerce.js';
import type { EventSink } from '../../src/ports/events.js';
import type { FileStorageProvider } from '../../src/ports/fileStorage.js';
import type { InboundRequest, MessagingProvider } from '../../src/ports/messaging.js';

export function commerceContract(name: string, make: () => CommerceProvider) {
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

export function messagingContract(
  name: string,
  make: () => MessagingProvider,
  validRaw: unknown,
  customerRef: string,
  /** Adapters that verify webhook signatures (WhatsApp, L2) pass a valid and a tampered request. */
  signature?: { valid: InboundRequest; invalid: InboundRequest },
) {
  describe(`MessagingProvider contract — ${name}`, () => {
    if (signature) {
      it('rejects an inbound request with an invalid signature (docs/07 §15) and accepts a valid one', () => {
        expect(() => make().verifyInbound(signature.invalid)).toThrow();
        expect(() => make().verifyInbound(signature.valid)).not.toThrow();
      });
    }

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

export function agentContract(name: string, make: () => AgentRuntime) {
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

export function fileStorageContract(
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

export function eventSinkContract(name: string, make: () => EventSink, readBack: () => Promise<string[]>) {
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
