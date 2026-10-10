import { MockAgentRuntime } from '../adapters/agent/mockAgentRuntime.js';
import { MockCommerceProvider } from '../adapters/commerce/mockCommerceProvider.js';
import { ShopifyHttpAdminApi } from '../adapters/commerce/shopifyAdminApi.js';
import { ShopifyCommerceProvider } from '../adapters/commerce/shopifyCommerceProvider.js';
import { FirestoreShopifyConnectionStore } from '../adapters/firestore/shopifyConnectionStore.js';
import { OnlineStockService } from '../application/onlineStock.js';
import { ShopifyAuthService } from '../application/shopifyAuthService.js';
import { ShopifyCatalogRefresh } from '../application/shopifyCatalogRefresh.js';
import { CommerceProviderResolver, ShopifyConnections } from '../application/shopifyConnections.js';
import { ShopifyOrderService } from '../application/shopifyOrderService.js';
import { ShopifyWebhookService } from '../application/shopifyWebhookService.js';
import { TokenCipher } from '../lib/tokenCipher.js';
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
import { BrandSettingsQuery, type ChannelMode } from '../application/brandSettingsQuery.js';
import { InsightsService } from '../application/insightsService.js';
import { FirestoreInsightsReader } from '../adapters/firestore/insightsReader.js';
import { LocalFileStorageProvider } from '../adapters/storage/localFileStorageProvider.js';
import { AccountService } from '../application/accountService.js';
import { CatalogService } from '../application/catalogService.js';
import { CommerceSyncService } from '../application/commerceSyncService.js';
import { PlatformAdminService } from '../application/platformAdminService.js';
import { DemoResetService } from '../application/demoResetService.js';
import { BundledFixtureSource } from '../adapters/fixtures/bundledFixtureSource.js';
import { FirestoreDemoDataStore } from '../adapters/firestore/demoDataStore.js';
import { RetailImportService } from '../application/retailImportService.js';
import { StoreService } from '../application/storeService.js';
import { TenantAdminService } from '../application/tenantAdminService.js';
import type { AppDeps } from '../app.js';
import { FirebaseTokenVerifier } from '../auth/tokenVerifier.js';
import type { Config } from '../config/env.js';
import type { AdapterSelection } from '../config/profile.js';
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
    // The shared provider is the mock in both modes: it is the synthetic demo shoppers' source.
    // With COMMERCE_PROVIDER=shopify each brand's catalogue comes from its own connected store
    // (CommerceProviderResolver, built in buildContainer from the brand's stored connection).
    commerce: new MockCommerceProvider(),
    messaging,
    agent: adapters.agentRuntime === 'mock' ? new MockAgentRuntime() : notAvailable('AdkGeminiAgentRuntime'),
    files:
      adapters.fileStorage === 'local'
        ? new LocalFileStorageProvider(localDataDir)
        : notAvailable('GCSFileStorageProvider'),
    events: adapters.eventSink === 'local' ? new LocalEventSink(localDataDir) : notAvailable('BigQueryEventSink'),
  };
}

/**
 * Profile-gated surfaces (docs/07 §19, Change 16): the demo storefront and the shopper
 * channel exist in the local profile, and in gcp only with DEMO_MODE on; the browser upload
 * target exists only in the local profile.
 */
export function profileFeatures(
  config: Pick<Config, 'profile' | 'adapters'> & { demo?: Pick<Config['demo'], 'enabled'> },
) {
  // The shopper demo (/api/shopper, /api/demo-storefront): local always; gcp only with DEMO_MODE on (Change 16).
  const shopperDemo = config.profile === 'local' || config.demo?.enabled === true;
  return {
    demoStorefront: shopperDemo,
    shopperDemo,
    localUploads: config.profile === 'local' && config.adapters.fileStorage === 'local',
  };
}

/** Which brands the shopper demo answers for: any in local; only the demo allowlist in gcp. */
/** The customer channel the Settings page names (Change 16, UI-3): WhatsApp once it is wired. */
export function channelModeOf(config: Pick<Config, 'adapters'>): ChannelMode {
  return config.adapters.messagingChannels.includes('whatsapp') ? 'WHATSAPP' : 'SIMULATOR';
}

export function shopperBrandAllowed(config: Pick<Config, 'profile' | 'demo'>): (brandId: string) => boolean {
  return config.profile === 'local' ? () => true : (brandId) => config.demo.brandIds.includes(brandId);
}

export interface Container {
  config: Config;
  providers: Providers;
  appDeps: AppDeps;
  /** StoreService (docs/06 §4); the agent tools apply the same store-truth rules. */
  storeService: StoreService;
  /** Reset demo; the seed scripts call rebuild() / writeHistory() directly. */
  demoReset: DemoResetService;
}

/** `now` is injectable for end-to-end tests (real due_at values without real waiting). */
export function buildContainer(config: Config, logger: Logger, options: { now?: () => Date } = {}): Container {
  const providers = createProviders(config);
  const { auth, db } = initFirebase(config.projectId, config.emulators);

  const users = new FirestoreUserRepository(db);
  const brands = new FirestoreBrandRepository(db);
  const retailers = new FirestoreRetailerRepository(db);
  const reservationRepo = new FirestoreReservationRepository(db);
  const insightsReader = new FirestoreInsightsReader(db);
  const stores = new FirestoreStoreRepository(db);
  const audit = new FirestoreAuditRepository(db);
  const identity = new FirebaseIdentityAdmin(auth);
  const products = new FirestoreProductRepository(db);
  const mappings = new FirestoreMappingRepository(db);
  const inventory = new FirestoreInventoryRepository(db);
  const connections = new FirestoreConnectionRepository(db);
  const imports = new FirestoreRetailImportRepository(db);
  const customers = new FirestoreCustomerRepository(db);
  // L2-Shopify: per-brand providers from each brand's stored, encrypted connection.
  const shopifyApp = config.shopify;
  let resolver: CommerceProviderResolver;
  let shopifyAuth: ShopifyAuthService | undefined;
  let shopifyStore: FirestoreShopifyConnectionStore | undefined;
  if (shopifyApp) {
    const api = new ShopifyHttpAdminApi(shopifyApp);
    shopifyStore = new FirestoreShopifyConnectionStore(db, new TokenCipher(shopifyApp.encryptionKey));
    const shopifyConnections = new ShopifyConnections({ store: shopifyStore, api, connections, now: options.now });
    resolver = new CommerceProviderResolver({
      mode: 'shopify',
      connections: shopifyConnections,
      create: (shop, accessToken) => new ShopifyCommerceProvider(api, shop, accessToken),
    });
    shopifyAuth = new ShopifyAuthService({
      app: shopifyApp,
      store: shopifyStore,
      api,
      connections,
      audit,
      now: options.now,
      accessToken: (brandId) => shopifyConnections.accessToken(brandId),
    });
  } else {
    resolver = new CommerceProviderResolver({ mode: 'mock', mock: providers.commerce });
  }
  const commerceSync = new CommerceSyncService({
    resolver,
    products,
    mappings,
    connections,
    audit,
  });
  const retailImports = new RetailImportService({
    files: providers.files,
    parser: new CsvRetailFileParser(),
    imports,
    stores,
    retailers,
    products,
    mappings,
    inventory,
    audit,
  });
  // Reset demo (Change 14, G4): refuses everything unless DEMO_MODE is on and the brand is allowlisted.
  const demoReset = new DemoResetService({
    demo: config.demo,
    data: new FirestoreDemoDataStore(db),
    fixtures: new BundledFixtureSource(),
    files: providers.files,
    brands,
    stores,
    products,
    customers,
    commerceSync,
    retailImports,
    audit,
    now: options.now,
  });
  const conversation = createConversationModule({
    brands,
    products,
    connections,
    customers,
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
    reservations: reservationRepo,
    outcomes: new FirestoreOutcomeRepository(db),
    attributionRefs: new FirestoreAttributionRefRepository(db),
    agent: providers.agent,
    logger,
    now: options.now,
    // The demo storefront and its demo shopper / order endpoints exist only in the local profile.
    demoStorefront: profileFeatures(config).demoStorefront ? { commerce: providers.commerce } : undefined,
    shopperChannel: profileFeatures(config).shopperDemo
      ? { sessionSecret: config.shopper.sessionSecret, brandAllowed: shopperBrandAllowed(config) }
      : undefined,
    publicOrigin: config.publicWebOrigin,
    onlineStock: shopifyApp ? new OnlineStockService({ resolver, logger, now: options.now }) : undefined,
  });

  // L2-Shopify: one order path for the webhooks and the order check; products/* re-sync in the background.
  const shopifyOrders = shopifyApp
    ? new ShopifyOrderService({
        receipts: new FirestoreWebhookReceiptRepository(db),
        orders: conversation.orders,
        products,
        resolver,
        audit,
        now: options.now,
      })
    : undefined;
  const catalogRefresh = shopifyApp ? new ShopifyCatalogRefresh({ sync: commerceSync, logger }) : undefined;
  const shopifyWebhooks =
    shopifyApp && shopifyStore && shopifyAuth && shopifyOrders && catalogRefresh
      ? new ShopifyWebhookService({
          apiSecret: shopifyApp.apiSecret,
          store: shopifyStore,
          receipts: new FirestoreWebhookReceiptRepository(db),
          orders: shopifyOrders,
          catalogChanged: (brandId) => void catalogRefresh.request(brandId),
          auth: shopifyAuth,
          audit,
          now: options.now,
        })
      : undefined;

  return {
    config,
    providers,
    storeService: new StoreService({ stores, inventory }),
    demoReset,
    appDeps: {
      config,
      logger,
      verifier: new FirebaseTokenVerifier(auth),
      repositories: { users, brands, retailers, stores },
      services: {
        platformAdmin: new PlatformAdminService({
          brands,
          users,
          identity,
          audit,
          stores,
          connections,
          mappings,
          inventory,
          reader: insightsReader,
          retailers,
          reservations: reservationRepo,
          now: options.now,
        }),
        tenantAdmin: new TenantAdminService({ users, retailers, stores, inventory, identity, audit }),
        account: new AccountService({ stores, inventory, products, brands, now: options.now }),
        commerceSync,
        catalog: new CatalogService({ products, mappings, inventory }),
        retailImports,
        intents: conversation.intents,
        simulator: conversation.simulator,
        conversations: conversation.queries,
        followUps: conversation.followUps,
        reservations: conversation.reservations,
        fulfilment: conversation.fulfilment,
        handoff: conversation.handoff,
        brandSettings: new BrandSettingsQuery({
          brands,
          channelMode: channelModeOf(config),
          commerceMode: config.adapters.commerce === 'shopify' ? 'SHOPIFY' : 'MOCK',
        }),
        insights: new InsightsService({
          reader: insightsReader,
          stores,
          retailers,
          products,
          now: options.now ?? (() => new Date()),
        }),
        demoStorefront: conversation.demoStorefront,
        shopper: conversation.shopper,
        demoReset,
        shopifyAuth,
        shopifyWebhooks,
        shopifyOrders,
      },
      localUploads:
        profileFeatures(config).localUploads && providers.files instanceof LocalFileStorageProvider
          ? providers.files
          : undefined,
    },
  };
}

/** Adapter names for startup logs and diagnostics. */
export function describeProviders(providers: Providers, adapters?: Pick<AdapterSelection, 'commerce'>) {
  return {
    commerce: adapters?.commerce === 'shopify' ? 'SHOPIFY' : providers.commerce.name,
    messaging_channels: [...providers.messaging.keys()],
    agent_runtime: providers.agent.runtime,
    file_storage: providers.files.name,
    event_sink: providers.events.name,
  };
}
