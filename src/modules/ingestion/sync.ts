import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import type { Database, DatabaseHandle } from '../../infrastructure/database/client.js';
import { syncState } from '../../infrastructure/database/schema.js';
import type { ChainAgentSource } from '../../integrations/erc8004/chain-reader.js';
import { classifyAgent } from '../classification/classifier.js';
import type { AgentRepository, AgentWritePayload } from '../agents/agent.repository.js';
import { agentDisplayName, blankToNull } from '../agents/agent.types.js';

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
 * Shared by every ingestion mode. Arbitrary but fixed: any constant works as long as all
 * of them agree, since the point is that they exclude each other.
 */
const INGESTION_LOCK_KEY = 8_004_056;

/** Deferred registration files fetched per backlog pass. */
const METADATA_BACKLOG_BATCH = 240;

/**
 * Concurrent fetches during a backlog pass.
 *
 * Higher than discovery's limit because this pass has nothing else to do — waiting on
 * HTTP is its entire job, so idle connections are pure waste. Still bounded, because the
 * backlog is dominated by a handful of hosts: 7,936 fetchable agents across 23 origins,
 * one of which serves most of them.
 *
 * ponytail: a flat limit, not per-host. The ceiling is that an unlucky batch puts every
 * slot on one origin. Upgrade path if a host starts refusing us: key the limiter by
 * hostname and back off per host.
 */
const METADATA_BACKLOG_CONCURRENCY = 16;

export interface MetadataBacklogResult {
  mode: 'metadata';
  attempted: number;
  resolved: number;
  failed: number;
  /** Agents still awaiting a fetch after this pass. */
  remaining: number;
}

/**
 * Retrieves the registration files that discovery deferred.
 *
 * The counterpart to `deferNetworkMetadata`. Discovery records an agent's on-chain
 * identity immediately and leaves `metadataResolvedAt` null when the document lives
 * behind someone else's HTTPS or IPFS URL; this pass goes back for those.
 *
 * Separating them is the whole point. Measured on the live registry, reading 1,200 agents
 * over Multicall3 takes about four seconds while a combined pass took sixty-five, because
 * one third-party host served ~90% of the fetches at 1.25s each. Their latency was
 * setting the rate at which the catalogue could grow. Now it only sets the rate at which
 * descriptions arrive, and an agent is browsable — identity, owner, ownership verified on
 * chain — the moment it is discovered.
 *
 * Writes go through the same `upsertMany` as discovery, so normalisation and
 * classification cannot drift between the two paths.
 */
/**
 * Runs `work` only if no other ingestion process holds the lock.
 *
 * A Postgres session-level advisory lock, released when the connection closes — including
 * on a crash — so a killed run cannot leave ingestion permanently locked out.
 *
 * This exists because the failure actually happened. Two backfill processes overlapped:
 * one had been orphaned by a terminal being closed without its child being killed, and it
 * kept committing an old cursor while a newer run raced ahead. The cursor went
 * *backwards* — 317,064 down to 154,250 — which loses no data, since the writes are
 * idempotent upserts, but silently condemns the next run to re-walk 160,000 ids for
 * nothing.
 *
 * The realistic production version of the same bug is a cron entry firing again while the
 * previous run is still going, which for a job that takes tens of minutes is not an edge
 * case.
 */
export async function withIngestionLock<T>(
  handle: DatabaseHandle,
  logger: Logger,
  work: () => Promise<T>,
): Promise<T | null> {
  /*
   * Taken on a reserved connection, not through the pool. See
   * `DatabaseHandle.withAdvisoryLock`: routing this through `db.execute` acquired the lock
   * on a borrowed connection that the pool closed twenty seconds later, which released the
   * lock while the job still believed it held one. Two ingestion processes ran side by side
   * under exactly the protection that was supposed to stop them.
   */
  const result = await handle.withAdvisoryLock(INGESTION_LOCK_KEY, work);

  if (result === null) {
    logger.warn('another ingestion process holds the lock, exiting rather than racing its cursor');
  }

  return result;
}

export async function resolveMetadataBacklog(
  options: SyncOptions & { limit?: number },
): Promise<MetadataBacklogResult> {
  const { logger, source, repository } = options;
  const limit = options.limit ?? METADATA_BACKLOG_BATCH;
  const now = new Date();

  const pending = await repository.findPendingMetadata(limit);
  if (pending.length === 0) {
    return { mode: 'metadata', attempted: 0, resolved: 0, failed: 0, remaining: 0 };
  }

  const payloads: AgentWritePayload[] = [];
  const failedIds: string[] = [];

  for (let i = 0; i < pending.length; i += METADATA_BACKLOG_CONCURRENCY) {
    const batch = pending.slice(i, i + METADATA_BACKLOG_CONCURRENCY);

    const settled = await Promise.all(
      batch.map(async (row) => {
        try {
          const profile = await source.resolveRegistration(row.agentUri);
          return { row, profile, reason: null };
        } catch (error) {
          return {
            row,
            profile: null,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    for (const entry of settled) {
      const { row } = entry;

      if (entry.profile === null) {
        failedIds.push(row.id);
        logger.debug({ agentId: row.agentId, reason: entry.reason }, 'metadata still unresolved');
        /*
         * The attempt is counted, but `metadataResolvedAt` stays null.
         *
         * Marking a failure as resolved would remove it from the backlog and lose the
         * retry; a transient outage would permanently strip an agent of its description.
         * Counting the attempt instead pushes the row to the back of the queue, so the
         * pass moves on to agents it has not tried yet and this one is still reachable
         * once everything ahead of it has had a turn. The UI keeps showing it honestly as
         * unresolved in the meantime.
         */
        continue;
      }

      const name = agentDisplayName(entry.profile.name, row.agentId);

      payloads.push({
        agent: {
          id: row.id,
          chainId: row.chainId,
          agentId: row.agentId,
          ownerAddress: row.ownerAddress,
          walletAddress: row.walletAddress,
          agentUri: row.agentUri,
          name,
          description: blankToNull(entry.profile.description),
          protocolTag: entry.profile.protocolTag,
          traitTags: entry.profile.traitTags,
          capabilities: entry.profile.capabilities,
          rawMetadata: entry.profile.rawMetadata,
          registeredAtBlock: row.registeredAtBlock,
          registeredAt: row.registeredAt,
          source: row.source,
          metadataResolvedAt: now,
          lastSyncedAt: now,
        },
        // Re-classified now that there is finally text to classify.
        categories: classifyAgent({
          name,
          description: entry.profile.description,
          capabilities: entry.profile.capabilities,
        }),
        reputation: null,
      });
    }
  }

  if (payloads.length > 0) await repository.upsertMany(payloads);
  await repository.recordMetadataFailures(failedIds, now);

  const remaining = await repository.countPendingMetadata();
  const result: MetadataBacklogResult = {
    mode: 'metadata',
    attempted: pending.length,
    resolved: payloads.length,
    failed: failedIds.length,
    remaining,
  };

  logger.info(result, 'metadata backlog pass complete');
  return result;
}

/** Agents whose reputation is read per sweep pass. */
const REPUTATION_SWEEP_BATCH = 2_000;

export interface ReputationSweepResult {
  mode: 'reputation';
  fromAgentId: number;
  toAgentId: number;
  /** Ids the registry answered for, including the ones with nothing to report. */
  swept: number;
  /** Of those, how many carry at least one piece of client feedback. */
  withFeedback: number;
  /** Ids the registry did not answer for. They stay unswept and are retried. */
  unanswered: number;
  remaining: number;
}

/**
 * Reads reputation for the whole catalogue.
 *
 * Reputation was only ever read when someone opened a profile, which left 130 of 317,476
 * agents scored. The consequence was not a blank panel, it was two sort options on the
 * marketplace ranking almost nothing: "highest reputation" and "most feedback" ordered a
 * set of 130 and put the other 317,346 behind them under `nulls last`. The landing page's
 * feedback figure had the same problem, and had to caveat itself as counting only what
 * KATTEGAT happened to have looked at.
 *
 * The per-agent read costs two sequential round trips, so at ~1.4s each the catalogue would
 * take over nine days. `reputationBatch` does the same work over Multicall3 at a measured
 * 168 ids/sec: about 31 minutes.
 *
 * Ids come from our own table rather than a counter, so gaps in the registry cost nothing
 * and every write has an agent row to point at. Progress is stored under its own cursor,
 * which is what lets a 31-minute job run inside a 15-minute CI timeout.
 *
 * Records agents with no feedback as well as those with some. That is the point: "swept, no
 * feedback" is a finding, and it is what lets the UI say "no feedback yet" as a fact rather
 * than as an admission that nobody checked.
 */
export async function sweepReputation(
  options: SyncOptions & { limit?: number },
): Promise<ReputationSweepResult> {
  const { db, logger, source, repository } = options;
  const cursorId = `${String(source.chainId)}:reputation:sweep`;
  const limit = options.limit ?? REPUTATION_SWEEP_BATCH;
  const now = new Date();

  const [existing] = await db.select().from(syncState).where(eq(syncState.id, cursorId)).limit(1);
  // `lastBlock` holds the last agent id for this cursor, as it does for the backfill.
  const afterAgentId = existing?.lastBlock ?? 0;

  const batch = await repository.findAgentIdsAfter(afterAgentId, limit);
  if (batch.length === 0) {
    /*
     * End of the catalogue. The cursor rewinds so the next run starts over.
     *
     * Reputation is not write-once like an agent's identity: a client can leave feedback at
     * any time, and a score read six months ago is not the score now. Without the rewind the
     * sweep would complete and then report 0 for ever, freezing every figure at whenever the
     * agent was first reached and quietly making the marketplace's central claim stale.
     *
     * Rewinding rather than deleting: the stored snapshots stay serving until each one is
     * overwritten, so a pass in progress never leaves the UI with a hole in it.
     */
    if (afterAgentId > 0) {
      await db
        .update(syncState)
        .set({ lastBlock: 0, lastRunAt: now, lastSuccessAt: now })
        .where(eq(syncState.id, cursorId));
      logger.info({ cursorId }, 'reputation sweep reached the end of the catalogue, rewinding');
    }

    return {
      mode: 'reputation',
      fromAgentId: afterAgentId,
      toAgentId: afterAgentId,
      swept: 0,
      withFeedback: 0,
      unanswered: 0,
      remaining: 0,
    };
  }

  const readings = await source.reputationBatch(batch.map((row) => row.agentId));

  const snapshots = batch.flatMap((row) => {
    const reading = readings.get(row.agentId);
    return reading === undefined ? [] : [{ id: row.id, reputation: reading }];
  });

  const written = await repository.saveReputationSnapshots(snapshots);
  const withFeedback = snapshots.filter((entry) => entry.reputation.feedbackCount > 0).length;

  /*
   * The cursor advances to the last id in the batch, not to the last id answered for.
   *
   * An id the registry did not answer for is a transport failure on our side, and stopping
   * the sweep there would let one bad chunk block the remaining 300,000 agents. Sweeping
   * is idempotent and cheap to repeat, so those ids are picked up by the next full pass
   * rather than by blocking this one.
   */
  const toAgentId = batch[batch.length - 1]?.agentId ?? afterAgentId;

  const cursorValues = {
    id: cursorId,
    lastBlock: toAgentId,
    lastRunAt: now,
    lastSuccessAt: now,
    lastError: null,
    consecutiveFailures: 0,
  };
  await db
    .insert(syncState)
    .values(cursorValues)
    .onConflictDoUpdate({ target: syncState.id, set: cursorValues });

  const remaining = (await repository.findAgentIdsAfter(toAgentId, 1)).length;

  const result: ReputationSweepResult = {
    mode: 'reputation',
    fromAgentId: afterAgentId + 1,
    toAgentId,
    swept: written,
    withFeedback,
    unanswered: batch.length - snapshots.length,
    remaining,
  };

  logger.info(result, 'reputation sweep pass complete');
  return result;
}

/** Whether a looping reputation sweep has more agents to read. */
export function reputationSweepHasMore(
  result: Pick<ReputationSweepResult, 'remaining'>,
): boolean {
  return result.remaining > 0;
}

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
    /*
     * Network metadata is deferred here and collected by `resolveMetadataBacklog`.
     *
     * The walk's job is to get every agent's on-chain identity recorded and browsable.
     * Blocking that on third-party HTTP made a 4-second multicall into a 65-second pass,
     * and left the catalogue growing at the speed of the slowest host in the registry.
     */
    const page = await source.discoverByIdRange(startId, endId, { deferNetworkMetadata: true });

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
