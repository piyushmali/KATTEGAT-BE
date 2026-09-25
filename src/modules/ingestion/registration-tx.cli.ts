/**
 * Operator entry point for the registration-transaction sweep.
 *
 *   BSC_ARCHIVE_RPC_URL=https://... pnpm backfill:registration-tx
 *   pnpm backfill:registration-tx --from=118000000 --to=118500000
 *
 * Thin on purpose: everything worth testing lives in `registration-tx.ts`, and this file only
 * resolves configuration, decides the block range and reports. See that module for why the
 * sweep exists separately from ingestion and why it needs an archive-capable endpoint.
 *
 * Resumable. The cursor lives in `sync_state` under `<chainId>:identity:tx`, so re-running
 * continues from the last completed window and a later run extends coverage to agents
 * registered since. `--from` overrides the cursor, `--to` stops short of the head.
 */

import { createPublicClient, http } from 'viem';
import { loadEnv } from '../../config/env.js';
import { createLogger } from '../../infrastructure/logging/logger.js';
import { createDatabase } from '../../infrastructure/database/client.js';
import { REGISTRY_CHAIN } from '../../integrations/bsc-client.js';
import { harvestRegistrationTxHashes, REGISTRY_DEPLOY_BLOCK } from './registration-tx.js';

function numericArg(name: string): number | null {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (raw === undefined) return null;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

async function main(): Promise<void> {
  process.env.LOG_LEVEL ??= 'info';

  const env = loadEnv();
  const logger = createLogger(env).child({ job: 'registration-tx' });
  const { db, close } = createDatabase(env, { logger });

  const rpcUrl = env.BSC_ARCHIVE_RPC_URL ?? env.BSC_RPC_URL;
  if (env.BSC_ARCHIVE_RPC_URL === undefined) {
    logger.warn(
      { rpcUrl },
      'BSC_ARCHIVE_RPC_URL is unset, falling back to BSC_RPC_URL. Free endpoints serve only ' +
        'recent blocks, so expect this to cover the tail of the history and refuse the rest.',
    );
  }

  const client = createPublicClient({
    chain: REGISTRY_CHAIN,
    /*
     * No viem-level retry: a narrowed window is this sweep's retry, and retrying a range
     * error three times only triples the wait before the narrowing happens. Long timeout
     * because a dense 50,000-block window is a large response.
     */
    transport: http(rpcUrl, { timeout: 60_000, retryCount: 0 }),
  });

  const chainId = REGISTRY_CHAIN.id;
  const cursorId = `${String(chainId)}:identity:tx`;

  try {
    const toBlock = numericArg('to') ?? Number(await client.getBlockNumber());
    const deployBlock =
      env.ERC8004_DEPLOY_BLOCK > 0 ? env.ERC8004_DEPLOY_BLOCK : REGISTRY_DEPLOY_BLOCK;

    const stored = await db.query.syncState.findFirst({
      where: (row, { eq }) => eq(row.id, cursorId),
    });
    const fromBlock = numericArg('from') ?? Math.max(deployBlock, (stored?.lastBlock ?? 0) + 1);

    if (fromBlock > toBlock) {
      logger.info({ fromBlock, toBlock }, 'cursor is already at the head; nothing to harvest');
      return;
    }

    logger.info(
      {
        registry: env.ERC8004_IDENTITY_REGISTRY,
        fromBlock,
        toBlock,
        blocks: toBlock - fromBlock + 1,
        rpcHost: new URL(rpcUrl).host,
      },
      'harvesting Registered transaction hashes',
    );

    const result = await harvestRegistrationTxHashes({
      db,
      client,
      logger,
      registryAddress: env.ERC8004_IDENTITY_REGISTRY,
      chainId,
      cursorId,
      fromBlock,
      toBlock,
    });

    logger.info(result, 'harvest complete');
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\nregistration-tx sweep failed: ${String(error)}\n`);
  process.exit(1);
});
