import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import type { Database } from '../../infrastructure/database/client.js';
import { syncState } from '../../infrastructure/database/schema.js';
import type { ChainAgentSource } from '../../integrations/erc8004/chain-reader.js';
import { classifyAgent } from '../classification/classifier.js';
import type { AgentRepository, AgentWritePayload } from '../agents/agent.repository.js';

/**
 * Agent ingestion: fetch, validate, normalise, classify, persist, record cursor.
 *
 * One sequential pass, run from the CLI. No queue, no worker pool, no scheduler —
 * the work is a bounded log scan against one chain, and a distributed pipeline
 * would add operational surface without making the marketplace better. The
 * abstraction that *does* matter is already in place: this function depends on
 * `AgentSource` and `AgentRepository`, so a second chain or a different index is
 * a new implementation rather than a rewrite here.
 */

export interface SyncResult {
  fromBlock: number;
  toBlock: number;
  /** True when the requested range exceeded the endpoint's log retention. */
  clamped: boolean;
  discovered: number;
  persisted: number;
  unresolvedMetadata: number;
  reputationRead: number;
  reputationFailed: number;
}

export interface SyncOptions {
  env: Env;
  db: Database;
  logger: Logger;
  source: ChainAgentSource;
  repository: AgentRepository;
  /** Ignore the stored cursor and re-scan the widest available window. */
  full?: boolean;
  /** Cap on reputation reads per run; each one costs two RPC calls. */
  maxReputationReads?: number;
}

const DEFAULT_MAX_REPUTATION_READS = 60;

export async function syncAgents(options: SyncOptions): Promise<SyncResult> {
  const { env, db, logger, source, repository } = options;
  const cursorId = `${String(source.chainId)}:identity`;
  const now = new Date();

  const [existing] = await db.select().from(syncState).where(eq(syncState.id, cursorId)).limit(1);

  const head = await source.latestBlock();
  const storedBlock = existing?.lastBlock ?? 0;

  // Resume one block past the cursor; fall back to the widest window the endpoint
  // will serve on a first run or an explicit full re-scan.
  const preferredFrom =
    options.full === true || storedBlock === 0
      ? head - env.ERC8004_MAX_LOOKBACK_BLOCKS
      : storedBlock + 1;

  const { fromBlock, clamped } = await source.resolveStartBlock(Math.max(0, preferredFrom));

  if (clamped) {
    logger.warn(
      { requested: preferredFrom, using: fromBlock },
      'requested range predates this endpoint log retention; set an archive RPC to backfill further',
    );
  }

  logger.info({ fromBlock, toBlock: head, cursorId }, 'agent sync starting');

  let result: SyncResult;

  try {
    const page = await source.discover({ fromBlock, toBlock: head });

    let reputationRead = 0;
    let reputationFailed = 0;
    const budget = options.maxReputationReads ?? DEFAULT_MAX_REPUTATION_READS;

    const payloads: AgentWritePayload[] = [];

    for (const discovered of page.agents) {
      const categories = classifyAgent({
        name: discovered.profile.name,
        description: discovered.profile.description,
        capabilities: discovered.profile.capabilities,
      });

      // Reputation costs two RPC calls per agent (getClients then getSummary), so
      // it is budgeted. Agents beyond the budget are persisted without it and
      // picked up by a later run rather than blocking this one.
      let reputation: AgentWritePayload['reputation'] = null;
      if (reputationRead < budget) {
        try {
          const snapshot = await source.reputation(discovered.identity.agentId);
          reputationRead += 1;
          if (snapshot) {
            reputation = {
              feedbackCount: snapshot.feedbackCount,
              clientCount: snapshot.clientCount,
              summaryValue: snapshot.summaryValue,
              summaryDecimals: snapshot.summaryDecimals,
              source: snapshot.source,
            };
          }
        } catch (error) {
          reputationFailed += 1;
          logger.debug(
            { agentId: discovered.identity.agentId, err: error },
            'reputation read failed; agent persisted without it',
          );
        }
      }

      payloads.push({
        agent: {
          id: discovered.identity.id,
          chainId: discovered.identity.chainId,
          agentId: discovered.identity.agentId,
          ownerAddress: discovered.identity.ownerAddress,
          walletAddress: discovered.identity.walletAddress,
          agentUri: discovered.identity.agentUri,
          name: discovered.profile.name,
          description: discovered.profile.description,
          protocolTag: discovered.profile.protocolTag,
          traitTags: discovered.profile.traitTags,
          capabilities: discovered.profile.capabilities,
          rawMetadata: discovered.rawMetadata,
          registeredAtBlock: discovered.identity.registeredAtBlock,
          registeredAt: discovered.identity.registeredAt,
          source: source.name,
          metadataResolvedAt: discovered.profile.metadataResolvedAt,
          lastSyncedAt: now,
        },
        categories,
        reputation,
      });
    }

    const persisted = await repository.upsertMany(payloads);

    // Only advance the cursor to the block the scan actually reached. `discover`
    // stops at the last successful window rather than throwing, so trusting
    // `head` here would silently skip every agent in the unread range.
    await db
      .insert(syncState)
      .values({
        id: cursorId,
        lastBlock: page.cursor,
        lastRunAt: now,
        lastSuccessAt: now,
        lastError: null,
        consecutiveFailures: 0,
      })
      .onConflictDoUpdate({
        target: syncState.id,
        set: {
          lastBlock: page.cursor,
          lastRunAt: now,
          lastSuccessAt: now,
          lastError: null,
          consecutiveFailures: 0,
        },
      });

    result = {
      fromBlock,
      toBlock: page.cursor,
      clamped,
      discovered: page.agents.length,
      persisted,
      unresolvedMetadata: page.unresolved.length,
      reputationRead,
      reputationFailed,
    };

    logger.info(result, 'agent sync complete');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Record the failure so /health can report a degraded integration instead of
    // reporting healthy while the catalogue silently goes stale.
    await db
      .insert(syncState)
      .values({
        id: cursorId,
        lastBlock: storedBlock,
        lastRunAt: now,
        lastError: message.slice(0, 500),
        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      })
      .onConflictDoUpdate({
        target: syncState.id,
        set: {
          lastRunAt: now,
          lastError: message.slice(0, 500),
          consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
        },
      });

    throw error;
  }
}
