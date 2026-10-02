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
import {
  agentContract,
  commerceContract,
  eventSinkContract,
  fileStorageContract,
  messagingContract,
} from './contracts/adapterContracts.js';

let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'qwikspot-test-'));
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

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
