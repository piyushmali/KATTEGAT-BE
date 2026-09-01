import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../../infrastructure/database/client.js';
import { syncState } from '../../infrastructure/database/schema.js';
import type { Erc8183JobReader } from '../../integrations/erc8183/job-reader.js';
import type { JobRepository } from '../jobs/job.repository.js';

/**
 * ERC-8183 job ingestion.
 *
 * Separate from agent ingestion because it shares none of its dependencies: no registry, no
 * registration files, no classifier. It reads one contract and writes one table.
 *
 * Two passes, for the same reason the agent side splits discovery from the metadata backlog:
 * they end differently.
 *
 *   discovery  walks forward from a cursor to `jobCounter`, and finishes.
 *   refresh    re-reads jobs that have not reached a terminal state, and never finishes.
 *
 * Refresh exists because a job is not a fact recorded once. It is created OPEN, funded, then
 * SUBMITTED by the provider, and only released to COMPLETED after a dispute window — seven
 * days on mainnet. Nearly every job in a live sample sat in SUBMITTED. Indexing once would
 * freeze an agent's page at whatever its jobs happened to be that afternoon, and would report
 * escrow as unsettled for ever.
 */

/** Jobs read per pass. Bounded so an interrupted run discards little and resumes cleanly. */
const JOB_SWEEP_BATCH = 600;

export interface JobSweepResult {
  mode: 'jobs';
  pass: 'discovery' | 'refresh';
  /** Ids asked for this pass. */
  requested: number;
  /** Jobs the chain actually returned. Lower when a job is not minted yet. */
  read: number;
  written: number;
  /** Provider-to-agent links added, removed or changed. */
  relinked: number;
  fromJobId: number;
  toJobId: number;
  /** Jobs still to reach beyond the cursor. Zero means this pass is done. */
  remaining: number;
}

export interface JobSweepOptions {
  db: Database;
  logger: Logger;
  jobs: Erc8183JobReader;
  repository: JobRepository;
  limit?: number;
  /** Re-read non-terminal jobs rather than discovering new ones. */
  refresh?: boolean;
}

/** True while a `--loop` should keep going. */
export function jobSweepHasMore(result: JobSweepResult): boolean {
  return result.remaining > 0;
}

export async function sweepJobs(options: JobSweepOptions): Promise<JobSweepResult> {
  const { db, logger, jobs, repository } = options;
  const limit = options.limit ?? JOB_SWEEP_BATCH;
  const pass = options.refresh === true ? 'refresh' : 'discovery';
  const chainId = jobs.chainId;
  const cursorId = `${String(chainId)}:jobs:${pass}`;
  const now = new Date();

  const [existing] = await db.select().from(syncState).where(eq(syncState.id, cursorId)).limit(1);
  // `lastBlock` holds the last job id for this cursor, as it holds the last agent id elsewhere.
  const afterJobId = existing?.lastBlock ?? 0;

  const ids =
    pass === 'discovery'
      ? await discoveryIds({ jobs, afterJobId, limit })
      : await repository.findPendingJobIdsAfter(chainId, afterJobId, limit);

  if (ids.length === 0) {
    /*
     * Nothing left to reach. Discovery has caught up with the counter and simply stops; the
     * next run picks up whatever was minted meanwhile.
     *
     * Refresh instead rewinds to the start, the same way the reputation sweep does. Its input
     * is "jobs that are not finished yet", and having walked to the end of that list once, the
     * jobs at the front may well have moved on. Without the rewind it would report nothing to
     * do for ever and every in-flight job would stay frozen at its first reading.
     */
    if (pass === 'refresh' && afterJobId > 0) {
      await db
        .update(syncState)
        .set({ lastBlock: 0, lastRunAt: now, lastSuccessAt: now })
        .where(eq(syncState.id, cursorId));
      logger.info({ cursorId }, 'job refresh reached the last pending job, rewinding');
    }

    return {
      mode: 'jobs',
      pass,
      requested: 0,
      read: 0,
      written: 0,
      relinked: 0,
      fromJobId: afterJobId,
      toJobId: afterJobId,
      remaining: 0,
    };
  }

  const read = await jobs.readJobs(ids);
  const written = await repository.save(read);

  /*
   * Attribution after every pass, not once at the end.
   *
   * It is a set operation over the whole table rather than something applied per job, so
   * running it here also repairs earlier rows: a job indexed before its provider's agent had
   * resolved a wallet address gets linked now, without a separate backfill mode.
   */
  const relinked = await repository.reattribute();

  /*
   * The cursor advances to the last id asked for, not the last one answered for.
   *
   * In discovery those differ when `jobCounter` moved between reading it and reading the jobs,
   * and stopping short would re-request the same ids for ever. Reads are idempotent, so
   * anything genuinely missed is picked up by the next pass rather than blocking this one.
   */
  const toJobId = ids[ids.length - 1] ?? afterJobId;

  const cursorValues = {
    id: cursorId,
    lastBlock: toJobId,
    lastRunAt: now,
    lastSuccessAt: now,
    lastError: null,
    consecutiveFailures: 0,
  };
  await db
    .insert(syncState)
    .values(cursorValues)
    .onConflictDoUpdate({ target: syncState.id, set: cursorValues });

  const remaining =
    pass === 'discovery'
      ? Math.max(0, (await jobs.jobCounter()) - toJobId)
      : await repository.countPendingAfter(chainId, toJobId);

  const result: JobSweepResult = {
    mode: 'jobs',
    pass,
    requested: ids.length,
    read: read.length,
    written,
    relinked,
    fromJobId: ids[0] ?? afterJobId,
    toJobId,
    remaining,
  };

  logger.info(result, 'job sweep pass complete');
  return result;
}

/** The next unindexed slice of the id space, clamped to what the kernel has minted. */
async function discoveryIds({
  jobs,
  afterJobId,
  limit,
}: {
  jobs: Erc8183JobReader;
  afterJobId: number;
  limit: number;
}): Promise<number[]> {
  const counter = await jobs.jobCounter();
  const from = afterJobId + 1;
  const to = Math.min(afterJobId + limit, counter);

  if (from > to) return [];

  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
