import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AccountService } from './application/accountService.js';
import type { CatalogService } from './application/catalogService.js';
import type { CommerceSyncService } from './application/commerceSyncService.js';
import type { ConversationQueryService } from './application/conversationQueryService.js';
import type { DemoStorefrontService } from './application/demoStorefrontService.js';
import type { FollowUpService } from './application/followUpService.js';
import type { IntentService } from './application/intentService.js';
import type { PlatformAdminService } from './application/platformAdminService.js';
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
import { healthRouter } from './routes/health.js';
import { intentsRouter } from './routes/intents.js';
import { localFilesRouter } from './routes/localFiles.js';
import { meRouter } from './routes/me.js';
import { platformRouter } from './routes/platform.js';
import { retailRouter } from './routes/retail.js';
import { retailImportsRouter } from './routes/retailImports.js';

export interface AppDeps {
  config: Pick<Config, 'corsAllowedOrigins'>;
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
    /** LOCAL PROFILE ONLY: the demo storefront (never wired in gcp). */
    demoStorefront?: DemoStorefrontService;
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
  app.use('/api', healthRouter());
  // PUBLIC storefront intent endpoint: origin allowlist + rate limits, no console auth (docs/06 §14.1).
  app.use('/api', intentsRouter(services.intents));
  if (services.demoStorefront) {
    app.use('/api/demo-storefront', demoStorefrontRouter(services.demoStorefront, services.intents));
  }

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
  tenant.use('/brand', requireScope('BRAND'), brandConversationsRouter(services.conversations, services.followUps));
  tenant.use('/channels/simulator', requireScope('BRAND'), simulatorRouter(services.simulator, services.conversations));
  if (localUploads) tenant.use('/local-files', requireScope('BRAND'), localFilesRouter(localUploads));
  // Retailer Console: store-scoped, RETAIL_ADMIN only.
  tenant.use('/retail', requireScope('RETAIL'), retailRouter(services.account));
  api.use(tenant);

  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
