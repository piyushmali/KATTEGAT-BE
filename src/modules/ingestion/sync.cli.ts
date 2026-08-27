import { loadEnv } from '../../config/env.js';
import { createDatabase } from '../../infrastructure/database/client.js';
import { createLogger } from '../../infrastructure/logging/logger.js';
import { createChainReader } from '../../integrations/erc8004/chain-reader.js';
import { createAgentRepository } from '../agents/agent.repository.js';
import { backfillAgents, syncAgents } from './sync.js';

/**
 * Runs one ingestion pass and exits.
 *
 *   pnpm sync:agents                     incremental — replays new Registered logs
 *   pnpm sync:agents --full              re-scan the widest log window available
 *   pnpm sync:agents --backfill          walk agent ids (reaches the whole registry)
 *   pnpm sync:agents --backfill --limit 500
 *   pnpm sync:agents --backfill --loop   repeat until the registry is exhausted
 *
 * Incremental sync replays logs, which is cheap but bounded by the endpoint's log
 * retention. Backfill walks ids with plain `eth_call`, which has no retention limit
 * and is the only way to reach the registry's history on a free RPC tier.
 *
 * A process rather than an in-server interval: ingestion and serving have different
 * failure modes and scaling needs, and a cron entry is easier to observe than a
 * background timer.
 */

function numericFlag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const handle = createDatabase(env);

  const isBackfill = process.argv.includes('--backfill');
  const loop = process.argv.includes('--loop');
  const limit = numericFlag('--limit');

  try {
    const deps = {
      env,
      db: handle.db,
      logger,
      source: createChainReader({ env, logger }),
      repository: createAgentRepository(handle.db),
    };

    if (!isBackfill) {
      const result = await syncAgents({ ...deps, full: process.argv.includes('--full') });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    // One pass, or repeated passes until the registry is exhausted. Each pass
    // commits its own cursor, so interrupting `--loop` loses at most one batch.
    let totalPersisted = 0;
    let passes = 0;

    for (;;) {
      const result = await backfillAgents({ ...deps, ...(limit === undefined ? {} : { limit }) });
      totalPersisted += result.persisted;
      passes += 1;

      if (!loop || result.remaining === 0 || result.discovered === 0) {
        process.stdout.write(
          `${JSON.stringify({ ...result, passes, totalPersisted }, null, 2)}\n`,
        );
        return;
      }
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
