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

/**
 * Agent ids resolved per pass. Bounded so a run is interruptible and resumable.
 *
 * Measured on BNB Smart Chain, walking a dense stretch of the id space:
 *
 *   150 ids   6s    25 ids/sec
 *   600 ids  14s    42 ids/sec
 *   2400 ids 36s    66 ids/sec
 *
 * Throughput climbs with batch size because the per-pass overhead — an id-space
 * bisect and a database round trip — is fixed. 1200 sits near the top of that curve
 * while still bounding what an interrupted pass discards to under half a minute of
 * work, which matters because the full walk is a multi-hour job.
 */
const BACKFILL_BATCH = 1_200;

/**
 * Whether a looping backfill has more work to do.
 *
 * Extracted and tested because the failure mode is silent. This condition previously
 * also stopped when a pass discovered no agents, which is wrong: an id range containing
 * nothing minted is a gap in the registry, not the end of it. Any sparse stretch would
 * have ended the walk early and reported success — the worst possible outcome for a job
 * whose entire purpose is completeness, because it looks finished.
 *
 * `remaining` is the only thing that answers the question.
 */
export function backfillHasMore(result: Pick<BackfillResult, 'remaining'>): boolean {
  return result.remaining > 0;
}

export interface BackfillResult {
  mode: 'backfill';
  fromId: number;
  toId: number;
  highestAgentId: number;
  discovered: number;
  persisted: number;
  unresolvedMetadata: number;
  /** Ids remaining after this pass. */
  remaining: number;
}

/**
 * Backfills the registry by walking agent ids.
 *
 * The reason this exists rather than just widening the log scan: no free RPC tier
 * can serve the registry's log history. publicnode retains ~8k blocks and
 * Alchemy's free tier caps `eth_getLogs` at 10 blocks, so log replay can only ever
 * see the last hour or two of registrations. Ids are readable with plain `eth_call`
 * with no retention limit, so this path can reach all ~310k agents.
 *
 * Progress is stored under its own cursor, so a run can be stopped and resumed, and
 * it never interferes with the incremental log cursor.
 */
export async function backfillAgents(
  options: SyncOptions & { limit?: number; knownHighestAgentId?: number },
): Promise<BackfillResult> {
  const { db, logger, source, repository } = options;
  const cursorId = `${String(source.chainId)}:identity:backfill`;
  const now = new Date();

  const [existing] = await db.select().from(syncState).where(eq(syncState.id, cursorId)).limit(1);
  /*
   * `highestAgentId` bisects the id space, which costs around nineteen `eth_call`s.
   * That is nothing once and thousands of wasted calls across a full walk, so a caller
   * looping over many passes hands back the value it already has. Omitted, it is
   * discovered as before, which keeps a single pass self-contained.
   */
  const highest = options.knownHighestAgentId ?? (await source.highestAgentId());

  // `lastBlock` stores the last agent id for this cursor. Reusing the column keeps
  // one table for both strategies; the cursor id says which unit it is in.
  const startId = (existing?.lastBlock ?? 0) + 1;

  if (startId > highest) {
    logger.info({ highest }, 'backfill already complete');
    return {
      mode: 'backfill',
      fromId: startId,
      toId: highest,
      highestAgentId: highest,
      discovered: 0,
      persisted: 0,
      unresolvedMetadata: 0,
      remaining: 0,
    };
  }

  const budget = options.limit ?? BACKFILL_BATCH;
  const endId = Math.min(startId + budget - 1, highest);

  logger.info({ fromId: startId, toId: endId, highest }, 'backfill starting');

  try {
    const page = await source.discoverByIdRange(startId, endId);

    const payloads: AgentWritePayload[] = page.agents.map((discovered) => ({
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
      categories: classifyAgent({
        name: discovered.profile.name,
        description: discovered.profile.description,
        capabilities: discovered.profile.capabilities,
      }),
      // Reputation is left to the incremental sync and the live endpoint: two extra
      // RPC calls per agent across 310k agents would dominate the run for data that
      // is read live on the detail page anyway.
      reputation: null,
    }));

    const persisted = await repository.upsertMany(payloads);

    const cursorValues = {
      id: cursorId,
      lastBlock: page.cursor,
      lastRunAt: now,
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
    };
    await db
      .insert(syncState)
      .values(cursorValues)
      .onConflictDoUpdate({ target: syncState.id, set: cursorValues });

    const result: BackfillResult = {
      mode: 'backfill',
      fromId: startId,
      toId: page.cursor,
      highestAgentId: highest,
      discovered: page.agents.length,
      persisted,
      unresolvedMetadata: page.unresolved.length,
      remaining: Math.max(0, highest - page.cursor),
    };

    logger.info(result, 'backfill pass complete');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;

    await db
      .insert(syncState)
      .values({
        id: cursorId,
        lastBlock: existing?.lastBlock ?? 0,
        lastRunAt: now,
        lastError: message.slice(0, 500),
        consecutiveFailures: failures,
      })
      .onConflictDoUpdate({
        target: syncState.id,
        set: { lastRunAt: now, lastError: message.slice(0, 500), consecutiveFailures: failures },
      });

    throw error;
  }
}

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
