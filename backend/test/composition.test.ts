import { describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '../src/adapters/agent/mockAgentRuntime.js';
import { MockCommerceProvider } from '../src/adapters/commerce/mockCommerceProvider.js';
import { LocalEventSink } from '../src/adapters/events/localEventSink.js';
import { SimulatorMessagingProvider } from '../src/adapters/messaging/simulatorMessagingProvider.js';
import { LocalFileStorageProvider } from '../src/adapters/storage/localFileStorageProvider.js';
import { AdapterNotAvailableError, createProviders, describeProviders } from '../src/composition/container.js';
import { loadConfig } from '../src/config/env.js';
import type { AdapterSelection } from '../src/config/profile.js';

const LOCAL: AdapterSelection = loadConfig({}).adapters;

describe('composition root — adapter selection', () => {
  it('the local profile wires every local adapter behind its port', () => {
    const providers = createProviders({ adapters: LOCAL, localDataDir: '.data-test' });
    expect(providers.commerce).toBeInstanceOf(MockCommerceProvider);
    expect(providers.agent).toBeInstanceOf(MockAgentRuntime);
    expect(providers.files).toBeInstanceOf(LocalFileStorageProvider);
    expect(providers.events).toBeInstanceOf(LocalEventSink);
    expect([...providers.messaging.keys()]).toEqual(['SIMULATOR']);
    expect(providers.messaging.get('SIMULATOR')).toBeInstanceOf(SimulatorMessagingProvider);
    expect(describeProviders(providers)).toEqual({
      commerce: 'MOCK',
      messaging_channels: ['SIMULATOR'],
      agent_runtime: 'MOCK',
      file_storage: 'LOCAL',
      event_sink: 'LOCAL',
    });
  });

  it('COMMERCE_PROVIDER=shopify: each brand gets its own Shopify provider; the shared one stays the synthetic-shopper mock', () => {
    const adapters = { ...LOCAL, commerce: 'shopify' } as AdapterSelection;
    const providers = createProviders({ adapters, localDataDir: '.d' });
    expect(providers.commerce).toBeInstanceOf(MockCommerceProvider);
    expect(describeProviders(providers, adapters).commerce).toBe('SHOPIFY');
  });

  it.each([
    [{ agentRuntime: 'adk_gemini' }, /AdkGeminiAgentRuntime/],
    [{ fileStorage: 'gcs' }, /GCSFileStorageProvider/],
    [{ eventSink: 'bigquery' }, /BigQueryEventSink/],
    [{ messagingChannels: ['whatsapp'] }, /WhatsAppMessagingProvider/],
  ] as const)(
    'a real adapter that does not exist yet fails loudly (%o), never silently falls back',
    (override, name) => {
      const build = () =>
        createProviders({ adapters: { ...LOCAL, ...override } as AdapterSelection, localDataDir: '.d' });
      expect(build).toThrow(AdapterNotAvailableError);
      expect(build).toThrow(name);
    },
  );
});
