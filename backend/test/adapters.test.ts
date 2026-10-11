/**
 * Port contract suites (docs/08_TEST_PLAN.md §4). Each suite is written against
 * the PORT and takes an adapter factory, so the same suite runs against the real
 * gcp adapters in phase L2.
 */
import { BigQueryEventSink, eventRow } from '../src/adapters/events/bigQueryEventSink.js';
import { GCSFileStorageProvider } from '../src/adapters/storage/gcsFileStorageProvider.js';
import { createProviders } from '../src/composition/container.js';
import { silentLogger } from '../src/lib/logger.js';
import { FakeBigQueryTable, InMemoryGcsBucket } from './gcpFakes.js';
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

// ---------------------------------------------------------------------------------------- L1 gcp adapters

describe('L1 gcp adapters on in-memory fakes (the same port contracts; no network)', () => {
  const bucket = new InMemoryGcsBucket();
  fileStorageContract(
    'GCSFileStorageProvider (in-memory bucket)',
    () => new GCSFileStorageProvider(bucket),
    async (key, body) => {
      bucket.objects.set(key, { data: Buffer.from(body), contentType: 'text/csv' });
    },
  );

  const table = new FakeBigQueryTable();
  const sink = new BigQueryEventSink(table);
  eventSinkContract(
    'BigQueryEventSink (fake table)',
    () => sink,
    async () => {
      await sink.flush();
      return table.rows.map((r) => JSON.stringify({ eventId: r.json.event_id }));
    },
  );

  it('GCS upload targets: a 15-minute V4 signed PUT that also caps the size (the browser sends both headers)', async () => {
    const b = new InMemoryGcsBucket();
    const now = new Date('2026-10-11T10:00:00.000Z');
    const target = await new GCSFileStorageProvider(b, () => now).createUploadTarget(
      'retail/brd_1/x.csv',
      'text/csv',
      1024,
    );
    expect(target).toEqual({
      method: 'PUT',
      url: expect.stringMatching(/^https:\/\/storage\.googleapis\.com\/test-bucket\/retail\/brd_1\/x\.csv\?/),
      headers: { 'Content-Type': 'text/csv', 'x-goog-content-length-range': '0,1024' },
      expiresAt: '2026-10-11T10:15:00.000Z',
    });
    expect(b.signed).toEqual([
      {
        name: 'retail/brd_1/x.csv',
        contentType: 'text/csv',
        expires: now.getTime() + 15 * 60_000,
        headers: { 'x-goog-content-length-range': '0,1024' },
      },
    ]);
    await expect(new GCSFileStorageProvider(b).createUploadTarget('retail/x.csv', 'text/csv', 0)).rejects.toThrow(
      /maxBytes/,
    );
    await new GCSFileStorageProvider(b).write('retail/brd_1/r.json', '{}', 'application/json');
    expect(b.objects.get('retail/brd_1/r.json')?.contentType).toBe('application/json');
  });

  it('BigQuery: emit never waits for or fails on BigQuery; a failure logs event ids and a code only', async () => {
    const t = new FakeBigQueryTable();
    const lines: string[] = [];
    const logger = { ...silentLogger, warn: (m: string, f?: object) => void lines.push(JSON.stringify({ m, ...f })) };
    const s = new BigQueryEventSink(t, logger);
    let release!: () => void;
    t.gate = new Promise((r) => (release = r));
    const event = {
      eventId: 'evt_1',
      brandId: 'brd_1',
      customerId: 'cus_1',
      webSessionId: 'ws_1',
      eventType: 'MESSAGE_RECEIVED' as const,
      source: 'WHATSAPP',
      entityReference: 'Asha asha@example.com +919800000000',
      eventPayloadReference: null,
      timestamp: '2026-10-11T10:00:00.000Z',
      idempotencyKey: 'k1',
    };
    await s.emit([event]); // resolves while the insert is still waiting
    expect(t.rows).toHaveLength(0);
    t.failWith = Object.assign(new Error('Asha asha@example.com quota'), { code: 403 });
    release();
    await s.flush();
    expect(lines).toEqual([
      JSON.stringify({ m: 'events.bigquery_insert_failed', event_ids: ['evt_1'], error_code: '403' }),
    ]);
    // A retry with the same event id is one row (insertId = event id).
    t.failWith = null;
    t.gate = null;
    await s.emit([event]);
    await s.emit([event]);
    await s.flush();
    expect(t.rows.map((r) => r.insertId)).toEqual(['evt_1']);
  });

  it('the row shape matches infrastructure/bigquery/events.schema.json exactly', async () => {
    const schema = JSON.parse(
      await readFile(new URL('../../infrastructure/bigquery/events.schema.json', import.meta.url), 'utf8'),
    ) as { name: string; mode: string }[];
    const row = eventRow({
      eventId: 'e',
      brandId: 'b',
      customerId: null,
      webSessionId: null,
      eventType: 'PRODUCT_VIEW',
      source: 'WEBSITE',
      entityReference: null,
      eventPayloadReference: null,
      timestamp: '2026-10-11T10:00:00.000Z',
      idempotencyKey: 'k',
    });
    expect(Object.keys(row.json).sort()).toEqual(schema.map((f) => f.name).sort());
    for (const f of schema.filter((x) => x.mode === 'REQUIRED')) expect(row.json[f.name]).not.toBeNull();
  });

  it('composition: gcs and bigquery are built from the gcp settings, never from nothing', () => {
    const adapters = {
      commerce: 'shopify',
      messagingChannels: ['simulator'],
      agentRuntime: 'mock',
      fileStorage: 'gcs',
      eventSink: 'bigquery',
    } as const;
    expect(() =>
      createProviders({ adapters: { ...adapters, messagingChannels: ['simulator'] }, localDataDir: '.d' }),
    ).toThrow(/GCS_BUCKET/);
    const providers = createProviders({
      adapters: { ...adapters, messagingChannels: ['simulator'] },
      localDataDir: '.d',
      projectId: 'qwikspot-test',
      gcp: { gcsBucket: 'qwikspot-qwikspot-uploads', bigQueryDataset: 'qwikspot' },
    });
    expect(providers.files).toBeInstanceOf(GCSFileStorageProvider);
    expect(providers.events).toBeInstanceOf(BigQueryEventSink);
  });
});
