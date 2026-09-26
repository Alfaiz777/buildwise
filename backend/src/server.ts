import { createApp } from './app.js';
import { FirebaseTokenVerifier } from './auth/tokenVerifier.js';
import { loadConfig } from './config/env.js';
import { initFirebase } from './firebase/admin.js';
import { createLogger } from './lib/logger.js';
import { FirestoreBrandRepository, FirestoreUserRepository } from './repositories/firestore.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const { auth, db } = initFirebase(config.projectId);

const app = createApp({
  config,
  logger,
  verifier: new FirebaseTokenVerifier(auth),
  users: new FirestoreUserRepository(db),
  brands: new FirestoreBrandRepository(db),
});

const server = app.listen(config.port, () => {
  logger.info('server.started', {
    port: config.port,
    node_env: config.nodeEnv,
    project_id: config.projectId,
    using_emulators: config.usingEmulators,
  });
});

// Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests.
const shutdown = (signal: string) => {
  logger.info('server.stopping', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
