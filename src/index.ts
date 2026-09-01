import { loadEnv } from './config/env.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { buildServer } from './app/server.js';

/**
 * Process entry point: load config, build the app, listen, and shut down cleanly.
 */
async function main(): Promise<void> {
  // Deliberately first. A configuration mistake should stop the process here,
  // with a readable report, rather than surfacing as a runtime error later.
  const env = loadEnv();
  const logger = createLogger(env);
  const app = await buildServer({ env, logger });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Fastify drains in-flight requests, then the onClose hook closes the pool.
    app
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(
    { url: `http://${env.HOST}:${String(env.PORT)}`, docs: '/docs' },
    'KATTEGAT API listening',
  );

  /*
   * Warm the landing page's stats aggregate.
   *
   * It costs 8.3s on a cold cache, because one of its nine counts has to scan the 290 MB agents
   * heap on a 256 MB instance. Once warm, the service serves stale readings while refreshing, so
   * nobody waits again. The gap that leaves is the first visitor after a restart, and this closes
   * it by making that first caller the process itself.
   *
   * Deliberately after `listen` and deliberately not awaited. The host polls for an open port and
   * kills a service that is slow to provide one, so warming must never sit between the process
   * starting and the port opening.
   */
  void app.services.stats
    .ecosystem()
    .then(() => {
      logger.info('stats cache warmed');
    })
    .catch((error: unknown) => {
      // Not fatal: the first request will simply pay for the read, as it did before.
      logger.warn({ err: error }, 'stats cache warm failed');
    });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config failed, so write directly.
  process.stderr.write(
    `failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
