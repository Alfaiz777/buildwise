import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AccountService } from './application/accountService.js';
import type { PlatformAdminService } from './application/platformAdminService.js';
import type { TenantAdminService } from './application/tenantAdminService.js';
import { authenticate } from './auth/authenticate.js';
import { requireScope } from './auth/authorize.js';
import type { TokenVerifier } from './auth/tokenVerifier.js';
import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import type { BrandRepository, RetailerRepository, StoreRepository, UserRepository } from './ports/repositories.js';
import { brandAdminRouter } from './routes/brandAdmin.js';
import { brandsRouter } from './routes/brands.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { platformRouter } from './routes/platform.js';
import { retailRouter } from './routes/retail.js';

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
  };
}

/** Builds the Express app. All I/O is injected (see composition/container.ts). */
export function createApp(deps: AppDeps): Express {
  const { config, logger, verifier, repositories, services } = deps;
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
        methods: ['GET', 'POST', 'PATCH'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        maxAge: 600,
      }),
    );
  }
  app.use(express.json({ limit: '100kb' }));

  // Public routes.
  app.use('/api', healthRouter());

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
  // Retailer Console: store-scoped, RETAIL_ADMIN only.
  tenant.use('/retail', requireScope('RETAIL'), retailRouter(services.account));
  api.use(tenant);

  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
