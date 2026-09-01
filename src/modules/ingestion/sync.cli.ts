import { loadEnv } from '../../config/env.js';
import { createDatabase } from '../../infrastructure/database/client.js';
import { createLogger } from '../../infrastructure/logging/logger.js';
import { createChainReader } from '../../integrations/erc8004/chain-reader.js';
import { createErc8183JobReader } from '../../integrations/erc8183/job-reader.js';
import { createAgentRepository } from '../agents/agent.repository.js';
import { createJobRepository } from '../jobs/job.repository.js';
import { jobSweepHasMore, sweepJobs } from './job-sync.js';
import {
  backfillAgents,
  backfillHasMore,
  reputationSweepHasMore,
  resolveMetadataBacklog,
  sweepReputation,
  syncAgents,
  withIngestionLock,
} from './sync.js';

/**
 * Runs one ingestion pass and exits.
 *
 *   pnpm sync:agents                     incremental — replays new Registered logs
 *   pnpm sync:agents --full              re-scan the widest log window available
 *   pnpm sync:agents --backfill          walk agent ids (reaches the whole registry)
 *   pnpm sync:agents --backfill --limit 500
 *   pnpm sync:agents --backfill --loop   repeat until the registry is exhausted
 *   pnpm sync:agents --metadata --loop   fetch the registration files discovery deferred
 *   pnpm sync:agents --reputation --loop read the ReputationRegistry for every agent
 *   pnpm sync:agents --jobs --loop       index ERC-8183 jobs from the escrow kernel
 *   pnpm sync:agents --jobs --refresh --loop  re-read jobs that have not settled yet
 *
 * `--loop` is a long job — the full registry is ~300k ids at roughly 65 ids/sec — so it
 * reports progress with an ETA and stops cleanly on SIGINT, finishing the pass in flight
 * before it saves. Interrupting it is safe at any point: the cursor advances per pass,
 * so resuming repeats at most one batch.
 *
 * Incremental sync replays logs, which is cheap but bounded by the endpoint's log
 * retention. Backfill walks ids with plain `eth_call`, which has no retention limit
 * and is the only way to reach the registry's history on a free RPC tier.
 *
 * A process rather than an in-server interval: ingestion and serving have different
 * failure modes and scaling needs, and a cron entry is easier to observe than a
 * background timer.
 */

/**
 * Consecutive zero-resolve metadata passes tolerated before `--loop` gives up.
 *
 * Above one, because one barren pass is expected: parts of the backlog are dead hosts and
 * skipping past them is progress. Low, because the backlog spans thousands of unrelated
 * hosts, so several passes failing in a row points at our end rather than theirs.
 */
const MAX_BARREN_PASSES = 5;

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

    /*
     * Every mode runs under one advisory lock. Two ingestion processes sharing a cursor
     * stomp each other — observed, with the cursor moving backwards 160,000 ids — and the
     * everyday cause is a scheduled run starting before the previous one has finished.
     */
    const outcome = await withIngestionLock(handle, logger, async () => {
      /*
       * Stop at the end of the current pass rather than mid-write.
       *
       * Declared before either looping mode because both need it: a full walk and a full
       * metadata backlog each run for a long time, so being able to stop them cleanly is a
       * requirement. Killing the process outright would abandon a pass whose work was done
       * but not committed — recoverable, since the cursor only advances on success, but
       * finishing the pass is free and keeps the log honest about where it reached.
       */
      let stopping = false;
      const requestStop = () => {
        if (stopping) return;
        stopping = true;
        logger.warn('stop requested, finishing the current pass then saving progress');
      };
      process.once('SIGINT', requestStop);
      process.once('SIGTERM', requestStop);

      /*
       * The metadata backlog: fetches the registration files the ID walk deferred.
       *
       * A separate mode rather than part of the walk, because the two are bound by
       * different things. Discovery is bound by RPC round trips and finishes in minutes;
       * this is bound by other people's web servers and takes as long as they take. Running
       * them together meant the slower one set the pace for both.
       */
      if (process.argv.includes('--metadata')) {
        let attempted = 0;
        let resolved = 0;
        let failed = 0;
        let passes = 0;
        let barrenPasses = 0;

        for (;;) {
          const result = await resolveMetadataBacklog({
            ...deps,
            ...(limit === undefined ? {} : { limit }),
          });
          attempted += result.attempted;
          resolved += result.resolved;
          failed += result.failed;
          passes += 1;

          // `attempted === 0` is the real end: nothing was left to try. A pass where
          // everything failed still has work remaining, so `remaining` alone would spin.
          const exhausted = result.attempted === 0;
          if (!loop || exhausted || stopping) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  mode: 'metadata',
                  passes,
                  attempted,
                  resolved,
                  failed,
                  remaining: result.remaining,
                },
                null,
                2,
              )}\n`,
            );
            return;
          }

          barrenPasses = result.resolved === 0 ? barrenPasses + 1 : 0;

          /*
           * A single barren pass is normal: some slices of the backlog are genuinely dead
           * hosts, and the pass still made progress by counting their attempts, which sends
           * them to the back of the queue so the next pass reaches different rows.
           *
           * A run of them means something broader is wrong, most likely our own network,
           * because the backlog spans thousands of independent hosts and they do not all
           * fail at once. Stop and say so rather than spending hours confirming it.
           */
          if (barrenPasses >= MAX_BARREN_PASSES) {
            logger.warn(
              { barrenPasses, attempted: result.attempted, remaining: result.remaining },
              'metadata resolved nothing across consecutive passes, stopping',
            );
            process.stdout.write(
              `${JSON.stringify(
                {
                  mode: 'metadata',
                  passes,
                  attempted,
                  resolved,
                  failed,
                  remaining: result.remaining,
                  stalled: true,
                },
                null,
                2,
              )}\n`,
            );
            return;
          }

          logger.info(
            { passes, resolved, failed, remaining: result.remaining },
            'metadata progress',
          );
        }
      }

      /*
       * The reputation sweep: reads the ReputationRegistry for every indexed agent.
       *
       * A separate mode for the same reason the metadata backlog is one. This is bound by
       * RPC round trips and takes about half an hour for the full catalogue, so folding it
       * into discovery would mean the catalogue only grew as fast as reputation could be
       * read. Its own cursor means a 31-minute job survives a 15-minute CI timeout.
       */
      if (process.argv.includes('--reputation')) {
        let swept = 0;
        let withFeedback = 0;
        let unanswered = 0;
        let passes = 0;
        const startedAt = Date.now();

        for (;;) {
          const result = await sweepReputation({
            ...deps,
            ...(limit === undefined ? {} : { limit }),
          });
          swept += result.swept;
          withFeedback += result.withFeedback;
          unanswered += result.unanswered;
          passes += 1;

          const done = !reputationSweepHasMore(result);
          if (!loop || done || stopping) {
            process.stdout.write(
              `${JSON.stringify(
                { mode: 'reputation', passes, swept, withFeedback, unanswered, done },
                null,
                2,
              )}\n`,
            );
            return;
          }

          const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
          logger.info(
            {
              passes,
              throughAgentId: result.toAgentId,
              swept,
              withFeedback,
              idsPerSecond: Math.round(swept / elapsed),
            },
            'reputation sweep progress',
          );
        }
      }

      /*
       * ERC-8183 jobs: the escrowed work agents were actually paid for.
       *
       * Its own mode because it reads a different contract for a different standard and shares
       * none of the agent pipeline. Two passes with different endings, hence the flag rather
       * than one loop: discovery catches up with the job counter and stops, refresh re-reads
       * whatever has not settled and rewinds. See job-sync.ts.
       */
      if (process.argv.includes('--jobs')) {
        const jobDeps = {
          db: handle.db,
          logger,
          jobs: createErc8183JobReader({ env, logger }),
          repository: createJobRepository(handle.db),
          refresh: process.argv.includes('--refresh'),
        };

        let requested = 0;
        let read = 0;
        let written = 0;
        let relinked = 0;
        let passes = 0;
        const startedAt = Date.now();

        for (;;) {
          const result = await sweepJobs({
            ...jobDeps,
            ...(limit === undefined ? {} : { limit }),
          });
          requested += result.requested;
          read += result.read;
          written += result.written;
          relinked += result.relinked;
          passes += 1;

          const done = !jobSweepHasMore(result);
          if (!loop || done || stopping) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  mode: 'jobs',
                  pass: result.pass,
                  passes,
                  requested,
                  read,
                  written,
                  relinked,
                  throughJobId: result.toJobId,
                  remaining: result.remaining,
                  done,
                  stoppedEarly: stopping && !done,
                  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
                },
                null,
                2,
              )}\n`,
            );
            return;
          }

          const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
          const perSecond = read / elapsed;
          logger.info(
            {
              passes,
              throughJobId: result.toJobId,
              remaining: result.remaining,
              written,
              jobsPerSecond: Number(perSecond.toFixed(1)),
              etaMinutes: Number((result.remaining / Math.max(1, perSecond) / 60).toFixed(1)),
            },
            'job sweep progress',
          );
        }
      }

      if (!isBackfill) {
        const result = await syncAgents({ ...deps, full: process.argv.includes('--full') });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      /*
       * One pass, or repeated passes until the registry is exhausted. Each pass commits
       * its own cursor, so interrupting `--loop` loses at most one batch.
       */
      let totalPersisted = 0;
      let totalDiscovered = 0;
      let passes = 0;
      const startedAt = Date.now();

      /*
       * Resolved once and handed to every pass. Each call bisects the id space for about
       * nineteen `eth_call`s, which across a few hundred passes is thousands of requests
       * spent re-learning something that barely changes.
       */
      const knownHighestAgentId = loop ? await deps.source.highestAgentId() : undefined;

      for (;;) {
        const result = await backfillAgents({
          ...deps,
          ...(limit === undefined ? {} : { limit }),
          ...(knownHighestAgentId === undefined ? {} : { knownHighestAgentId }),
        });
        totalPersisted += result.persisted;
        totalDiscovered += result.discovered;
        passes += 1;

        /*
         * `remaining` is the only correct termination condition.
         *
         * This previously also stopped on `discovered === 0`, which is wrong: an id range
         * containing no minted agents is a gap in the registry, not the end of it. Any
         * sparse stretch would have silently ended the walk early and reported success,
         * which is the worst possible failure for a job whose whole purpose is
         * completeness — it looks finished.
         */
        const done = !backfillHasMore(result);

        if (loop && !done && !stopping) {
          /*
           * Progress and a rate-based estimate, because a multi-hour job that prints
           * nothing is indistinguishable from one that has hung.
           *
           * The rate is measured over the whole run rather than the last pass, so a single
           * slow batch does not throw the estimate around.
           */
          const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
          const idsPerSecond = totalDiscovered / elapsedSeconds;

          logger.info(
            {
              passes,
              cursor: result.toId,
              remaining: result.remaining,
              totalPersisted,
              idsPerSecond: Number(idsPerSecond.toFixed(1)),
              etaMinutes: Number((result.remaining / Math.max(1, idsPerSecond) / 60).toFixed(1)),
            },
            'backfill progress',
          );
          continue;
        }

        process.stdout.write(
          `${JSON.stringify(
            {
              ...result,
              passes,
              totalPersisted,
              stoppedEarly: stopping && !done,
              elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
    });

    /*
     * `null` means the lock was held elsewhere. Not an error — the other process is doing
     * the work — so this exits 0 rather than failing a cron job that behaved correctly.
     */
    if (outcome === null) {
      process.stdout.write(`${JSON.stringify({ skipped: 'ingestion already running' })}\n`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
