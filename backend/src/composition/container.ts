import { MockAgentRuntime } from '../adapters/agent/mockAgentRuntime.js';
import { MockCommerceProvider } from '../adapters/commerce/mockCommerceProvider.js';
import { LocalEventSink } from '../adapters/events/localEventSink.js';
import { FirebaseIdentityAdmin } from '../adapters/firebase/identityAdmin.js';
import {
  FirestoreAuditRepository,
  FirestoreBrandRepository,
  FirestoreConnectionRepository,
  FirestoreInventoryRepository,
  FirestoreMappingRepository,
  FirestoreProductRepository,
  FirestoreRetailerRepository,
  FirestoreRetailImportRepository,
  FirestoreStoreRepository,
  FirestoreUserRepository,
} from '../adapters/firestore/repositories.js';
import { SimulatorMessagingProvider } from '../adapters/messaging/simulatorMessagingProvider.js';
import { FirestoreReservationRepository } from '../adapters/firestore/reservationRepository.js';
import {
  FirestoreAttributionRefRepository,
  FirestoreOutcomeRepository,
} from '../adapters/firestore/outcomeRepository.js';
import { CsvRetailFileParser } from '../adapters/retail/csvRetailFileParser.js';
import {
  FirestoreCommerceEventRepository,
  FirestoreConversationRepository,
  FirestoreCustomerRepository,
  FirestoreIntentRepository,
  FirestoreIntentTokenRepository,
  FirestoreRecommendationRepository,
  FirestoreVisitorLinkRepository,
  FirestoreWebhookReceiptRepository,
} from '../adapters/firestore/conversationRepositories.js';
import { createConversationModule } from '../application/conversationModule.js';
import { InsightsService } from '../application/insightsService.js';
import { FirestoreInsightsReader } from '../adapters/firestore/insightsReader.js';
import { LocalFileStorageProvider } from '../adapters/storage/localFileStorageProvider.js';
import { AccountService } from '../application/accountService.js';
import { CatalogService } from '../application/catalogService.js';
import { CommerceSyncService } from '../application/commerceSyncService.js';
import { PlatformAdminService } from '../application/platformAdminService.js';
import { RetailImportService } from '../application/retailImportService.js';
import { StoreService } from '../application/storeService.js';
import { TenantAdminService } from '../application/tenantAdminService.js';
import type { AppDeps } from '../app.js';
import { FirebaseTokenVerifier } from '../auth/tokenVerifier.js';
import type { Config } from '../config/env.js';
import type { Channel } from '../domain/channels.js';
import { initFirebase } from '../firebase/admin.js';
import type { Logger } from '../lib/logger.js';
import type { AgentRuntime } from '../ports/agent.js';
import type { CommerceProvider } from '../ports/commerce.js';
import type { EventSink } from '../ports/events.js';
import type { FileStorageProvider } from '../ports/fileStorage.js';
import type { MessagingProvider } from '../ports/messaging.js';

/**
 * The composition root: the ONLY place that reads the execution profile and
 * decides which adapter sits behind each port (docs/03_TECH_ARCHITECTURE.md §2.1–§2.2).
 * Everything else depends on the port interfaces.
 */

export interface Providers {
  commerce: CommerceProvider;
  /** One MessagingProvider per enabled customer channel. */
  messaging: ReadonlyMap<Channel, MessagingProvider>;
  agent: AgentRuntime;
  files: FileStorageProvider;
  events: EventSink;
}

/** A real (gcp) adapter was selected before the milestone that implements it. */
export class AdapterNotAvailableError extends Error {
  constructor(adapter: string, phase: string) {
    super(`${adapter} is not implemented yet (planned for ${phase}, see docs/10_EXECUTION_PLAN.md)`);
    this.name = 'AdapterNotAvailableError';
  }
}

const notAvailable = (adapter: string, phase = 'phase L2'): never => {
  throw new AdapterNotAvailableError(adapter, phase);
};

export function createProviders(config: Pick<Config, 'adapters' | 'localDataDir'>): Providers {
  const { adapters, localDataDir } = config;

  const messaging = new Map<Channel, MessagingProvider>();
  for (const channel of adapters.messagingChannels) {
    if (channel === 'simulator') messaging.set('SIMULATOR', new SimulatorMessagingProvider());
    else notAvailable('WhatsAppMessagingProvider');
  }

  return {
    commerce: adapters.commerce === 'mock' ? new MockCommerceProvider() : notAvailable('ShopifyCommerceProvider'),
    messaging,
    agent: adapters.agentRuntime === 'mock' ? new MockAgentRuntime() : notAvailable('AdkGeminiAgentRuntime'),
    files:
      adapters.fileStorage === 'local'
        ? new LocalFileStorageProvider(localDataDir)
        : notAvailable('GCSFileStorageProvider'),
    events: adapters.eventSink === 'local' ? new LocalEventSink(localDataDir) : notAvailable('BigQueryEventSink'),
  };
}

export interface Container {
  config: Config;
  providers: Providers;
  appDeps: AppDeps;
  /** StoreService (docs/06 §4); the agent tools apply the same store-truth rules. */
  storeService: StoreService;
}

/** `now` is injectable for end-to-end tests (real due_at values without real waiting). */
export function buildContainer(config: Config, logger: Logger, options: { now?: () => Date } = {}): Container {
  const providers = createProviders(config);
  const { auth, db } = initFirebase(config.projectId, config.emulators);

  const users = new FirestoreUserRepository(db);
  const brands = new FirestoreBrandRepository(db);
  const retailers = new FirestoreRetailerRepository(db);
  const stores = new FirestoreStoreRepository(db);
  const audit = new FirestoreAuditRepository(db);
  const identity = new FirebaseIdentityAdmin(auth);
  const products = new FirestoreProductRepository(db);
  const mappings = new FirestoreMappingRepository(db);
  const inventory = new FirestoreInventoryRepository(db);
  const connections = new FirestoreConnectionRepository(db);
  const imports = new FirestoreRetailImportRepository(db);
  const conversation = createConversationModule({
    brands,
    products,
    customers: new FirestoreCustomerRepository(db),
    visitors: new FirestoreVisitorLinkRepository(db),
    intents: new FirestoreIntentRepository(db),
    tokens: new FirestoreIntentTokenRepository(db),
    conversations: new FirestoreConversationRepository(db),
    recommendations: new FirestoreRecommendationRepository(db),
    receipts: new FirestoreWebhookReceiptRepository(db),
    events: new FirestoreCommerceEventRepository(db),
    audit,
    sink: providers.events,
    messaging: providers.messaging,
    stores,
    inventory,
    reservations: new FirestoreReservationRepository(db),
    outcomes: new FirestoreOutcomeRepository(db),
    attributionRefs: new FirestoreAttributionRefRepository(db),
    agent: providers.agent,
    logger,
    now: options.now,
    // The demo storefront and its demo shopper / order endpoints exist only in the local profile.
    demoStorefront: config.profile === 'local' ? { commerce: providers.commerce } : undefined,
  });

  return {
    config,
    providers,
    storeService: new StoreService({ stores, inventory }),
    appDeps: {
      config,
      logger,
      verifier: new FirebaseTokenVerifier(auth),
      repositories: { users, brands, retailers, stores },
      services: {
        platformAdmin: new PlatformAdminService({ brands, users, identity, audit }),
        tenantAdmin: new TenantAdminService({ users, retailers, stores, inventory, identity, audit }),
        account: new AccountService({ stores, inventory, products }),
        commerceSync: new CommerceSyncService({ commerce: providers.commerce, products, mappings, connections, audit }),
        catalog: new CatalogService({ products, mappings, inventory }),
        retailImports: new RetailImportService({
          files: providers.files,
          parser: new CsvRetailFileParser(),
          imports,
          stores,
          retailers,
          products,
          mappings,
          inventory,
          audit,
        }),
        intents: conversation.intents,
        simulator: conversation.simulator,
        conversations: conversation.queries,
        followUps: conversation.followUps,
        reservations: conversation.reservations,
        fulfilment: conversation.fulfilment,
        handoff: conversation.handoff,
        insights: new InsightsService({
          reader: new FirestoreInsightsReader(db),
          stores,
          retailers,
          products,
          now: options.now ?? (() => new Date()),
        }),
        demoStorefront: conversation.demoStorefront,
      },
      localUploads: providers.files instanceof LocalFileStorageProvider ? providers.files : undefined,
    },
  };
}

/** Adapter names for startup logs and diagnostics. */
export function describeProviders(providers: Providers) {
  return {
    commerce: providers.commerce.name,
    messaging_channels: [...providers.messaging.keys()],
    agent_runtime: providers.agent.runtime,
    file_storage: providers.files.name,
    event_sink: providers.events.name,
  };
}
