import { createApp } from './app.js';
import { buildContainer, describeProviders } from './composition/container.js';
import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const container = buildContainer(config, logger);
const app = createApp(container.appDeps);

const server = app.listen(config.port, () => {
  logger.info('server.started', {
    port: config.port,
    node_env: config.nodeEnv,
    profile: config.profile,
    project_id: config.projectId,
    using_emulators: config.usingEmulators,
    adapters: describeProviders(container.providers),
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
