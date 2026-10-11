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
    adapters: describeProviders(container.providers, config.adapters),
  });
  // L1 staged rollout: say loudly, once, what this gcp deployment runs instead of the target adapters.
  if (config.staged.length > 0) {
    logger.warn('server.staged_rollout', {
      staged: config.staged,
      note: 'GCP_STAGED_ROLLOUT=true: temporary stand-ins until the Gemini and WhatsApp adapters ship',
    });
  }
});

// Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests.
const shutdown = (signal: string) => {
  logger.info('server.stopping', { signal });
  // L1: let queued BigQuery inserts finish before the instance stops.
  const events = container.providers.events as { flush?: () => Promise<void> };
  server.close(() => void (events.flush?.() ?? Promise.resolve()).finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
