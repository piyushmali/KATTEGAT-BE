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
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config failed, so write directly.
  process.stderr.write(
    `failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
