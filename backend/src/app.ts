import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { authenticate } from './auth/authenticate.js';
import type { TokenVerifier } from './auth/tokenVerifier.js';
import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import type { BrandRepository, UserRepository } from './repositories/types.js';
import { brandsRouter } from './routes/brands.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';

export interface AppDeps {
  config: Pick<Config, 'corsAllowedOrigins'>;
  logger: Logger;
  verifier: TokenVerifier;
  users: UserRepository;
  brands: BrandRepository;
}

/** Builds the Express app. All I/O is injected so tests can replace Firebase. */
export function createApp(deps: AppDeps): Express {
  const { config, logger, verifier, users, brands } = deps;
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

  // Everything below requires a verified Firebase user (docs/07_SECURITY_SPEC.md §4.1).
  const api = express.Router();
  api.use(authenticate({ verifier, users, brands, logger }));
  api.use(meRouter());
  api.use(brandsRouter(brands));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
