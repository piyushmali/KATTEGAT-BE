import { loadEnv } from '../../config/env.js';
import { createDatabase } from '../../infrastructure/database/client.js';
import { createLogger } from '../../infrastructure/logging/logger.js';
import { createChainReader } from '../../integrations/erc8004/chain-reader.js';
import { createAgentRepository } from '../agents/agent.repository.js';
import { syncAgents } from './sync.js';

/**
 * Runs one ingestion pass and exits.
 *
 *   pnpm sync:agents          incremental, resumes from the stored cursor
 *   pnpm sync:agents --full   re-scan the widest window the RPC endpoint serves
 *
 * A process rather than an in-server interval: ingestion and serving have
 * different failure modes and different scaling needs, and a cron entry or a
 * scheduled CI job is easier to observe than a background timer.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const handle = createDatabase(env);

  try {
    const result = await syncAgents({
      env,
      db: handle.db,
      logger,
      source: createChainReader({ env, logger }),
      repository: createAgentRepository(handle.db),
      full: process.argv.includes('--full'),
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
