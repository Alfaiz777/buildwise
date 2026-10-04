import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AccountService } from './application/accountService.js';
import type { CatalogService } from './application/catalogService.js';
import type { CommerceSyncService } from './application/commerceSyncService.js';
import type { ConversationQueryService } from './application/conversationQueryService.js';
import type { DemoResetService } from './application/demoResetService.js';
import type { ShopperChannelService } from './application/shopperChannel.js';
import type { DemoStorefrontService } from './application/demoStorefrontService.js';
import type { FollowUpService } from './application/followUpService.js';
import type { IntentService } from './application/intentService.js';
import type { PlatformAdminService } from './application/platformAdminService.js';
import type { ReservationService } from './application/reservationService.js';
import type { FulfilmentService } from './application/fulfilmentService.js';
import type { HandoffService } from './application/handoffService.js';
import type { InsightsService } from './application/insightsService.js';
import { insightsRouter } from './routes/insights.js';
import type { RetailImportService } from './application/retailImportService.js';
import type { SimulatorService } from './application/simulatorService.js';
import type { TenantAdminService } from './application/tenantAdminService.js';
import { authenticate } from './auth/authenticate.js';
import { requireScope } from './auth/authorize.js';
import type { TokenVerifier } from './auth/tokenVerifier.js';
import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import type { LocalUploadReceiver } from './ports/fileStorage.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import type { BrandRepository, RetailerRepository, StoreRepository, UserRepository } from './ports/repositories.js';
import { brandAdminRouter } from './routes/brandAdmin.js';
import { brandsRouter } from './routes/brands.js';
import { connectionsRouter, integrationsRouter, productsRouter } from './routes/catalog.js';
import { brandConversationsRouter, simulatorRouter } from './routes/conversations.js';
import { demoStorefrontRouter } from './routes/demoStorefront.js';
import { brandDemoRouter, demoRouter } from './routes/demo.js';
import { shopperRouter } from './routes/shopper.js';
import { healthRouter } from './routes/health.js';
import { intentsRouter } from './routes/intents.js';
import { localFilesRouter } from './routes/localFiles.js';
import { meRouter } from './routes/me.js';
import { platformRouter } from './routes/platform.js';
import { retailRouter } from './routes/retail.js';
import { retailImportsRouter } from './routes/retailImports.js';
import { reservationsRouter } from './routes/reservations.js';

export interface AppDeps {
  config: Pick<Config, 'corsAllowedOrigins'> & Partial<Pick<Config, 'profile' | 'demo' | 'build'>>;
  logger: Logger;
  verifier: TokenVerifier;
  repositories: {
    users: UserRepository;
    brands: BrandRepository;
    retailers: RetailerRepository;
    stores: StoreRepository;
  };
  services: {
    platformAdmin: PlatformAdminService;
    tenantAdmin: TenantAdminService;
    account: AccountService;
    commerceSync: CommerceSyncService;
    catalog: CatalogService;
    retailImports: RetailImportService;
    intents: IntentService;
    simulator: SimulatorService;
    conversations: ConversationQueryService;
    followUps: FollowUpService;
    reservations: ReservationService;
    fulfilment: FulfilmentService;
    handoff: HandoffService;
    insights: InsightsService;
    /** LOCAL PROFILE ONLY: the demo storefront (never wired in gcp). */
    demoStorefront?: DemoStorefrontService;
    /** Reset demo; refuses unless DEMO_MODE is on and the brand is allowlisted. */
    demoReset?: DemoResetService;
    /** The shopper demo channel (Change 16): local, or gcp with DEMO_MODE on. */
    shopper?: ShopperChannelService;
  };
  /** Local profile only: receives browser uploads for LocalFileStorageProvider. */
  localUploads?: LocalUploadReceiver;
}

/** Builds the Express app. All I/O is injected (see composition/container.ts). */
export function createApp(deps: AppDeps): Express {
  const { config, logger, verifier, repositories, services, localUploads } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Cloud Run sits behind Google's front end; trust it for req.ip / protocol.
  app.set('trust proxy', true);

  app.use(requestContext(logger));
  app.use(helmet());
  if (config.corsAllowedOrigins.length > 0) {
    // Only needed when the SPA calls Cloud Run directly. The default path is
    // same-origin via the Firebase Hosting rewrite / Vite proxy. No cookies are used.
    app.use(
      cors({
        origin: config.corsAllowedOrigins,
        methods: ['GET', 'POST', 'PATCH', 'PUT'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
      }),
    );
  }
  app.use(express.json({ limit: '100kb' }));

  // Public routes.
  app.use(
    '/api',
    healthRouter({ version: config.build?.version, commit: config.build?.commit, profile: config.profile }),
  );
  // PUBLIC: the judged demo's login panel (DEMO_MODE only returns logins).
  const shopperDemoBrand = services.shopper
    ? (config.profile ?? 'local') === 'local'
      ? 'brd_demo'
      : (config.demo?.brandIds[0] ?? null)
    : null;
  app.use('/api', demoRouter(config.demo, shopperDemoBrand));
  // PUBLIC storefront intent endpoint: origin allowlist + rate limits, no console auth (docs/06 §14.1).
  app.use('/api', intentsRouter(services.intents));
  if (services.demoStorefront) {
    const allowed = (brandId: string) => services.shopper?.isBrandAllowed(brandId) ?? true;
    app.use('/api/demo-storefront', demoStorefrontRouter(services.demoStorefront, services.intents, allowed));
  }
  // PUBLIC shopper demo channel (Change 16): signed session tokens, origin allowlist, rate limits.
  if (services.shopper) app.use('/api/shopper', shopperRouter(services.shopper));

  // Everything below requires a verified console user (docs/07_SECURITY_SPEC.md §4.1).
  const api = express.Router();
  api.use(authenticate({ verifier, logger, ...repositories }));
  api.use(meRouter());

  // Platform scope: /api/platform/* only.
  api.use('/platform', requireScope('PLATFORM'), platformRouter(services.platformAdmin));

  // Tenant routes: PLATFORM_ADMIN is refused here (403), before any handler runs.
  const tenant = express.Router();
  tenant.use(requireScope('BRAND', 'RETAIL'));
  tenant.use(brandsRouter(repositories.brands));
  tenant.use('/brand', requireScope('BRAND'), brandAdminRouter(services.tenantAdmin));
  tenant.use('/brand', requireScope('BRAND'), connectionsRouter(services.commerceSync));
  tenant.use('/brand/retail-imports', requireScope('BRAND'), retailImportsRouter(services.retailImports));
  tenant.use('/integrations', requireScope('BRAND'), integrationsRouter(services.commerceSync));
  tenant.use('/products', requireScope('BRAND'), productsRouter(services.catalog));
  tenant.use(
    '/brand',
    requireScope('BRAND'),
    brandConversationsRouter(services.conversations, services.followUps, services.handoff),
  );
  tenant.use('/brand', requireScope('BRAND'), insightsRouter(services.insights));
  if (services.demoReset) tenant.use('/brand', requireScope('BRAND'), brandDemoRouter(services.demoReset));
  tenant.use('/channels/simulator', requireScope('BRAND'), simulatorRouter(services.simulator, services.conversations));
  if (localUploads) tenant.use('/local-files', requireScope('BRAND'), localFilesRouter(localUploads));
  // Retailer Console: store-scoped, RETAIL_ADMIN only.
  tenant.use('/retail', requireScope('RETAIL'), retailRouter(services.account, services.reservations));
  tenant.use('/reservations', reservationsRouter(services.reservations, services.fulfilment));
  api.use(tenant);

  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger, (config.profile ?? 'local') === 'local'));
  return app;
}
