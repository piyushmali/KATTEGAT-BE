import { sql } from 'drizzle-orm';
import { parseAbiItem, type Hex, type PublicClient } from 'viem';
import type { Logger } from 'pino';
import type { Database } from '../../infrastructure/database/client.js';
import { syncState } from '../../infrastructure/database/schema.js';

/**
 * Harvests each agent's `Registered` transaction hash from the identity registry's logs.
 *
 * Why this is its own sweep rather than part of ingestion
 * -------------------------------------------------------
 * `agents.registration_tx_hash` is the field that makes a listing independently checkable.
 * With it, anyone can paste one hash into BscScan and see the registry address, the agent id
 * and the owner for themselves — no need to trust this marketplace and no need to know how to
 * call a contract.
 *
 * Ingestion cannot fill it, because only one of the two discovery paths ever sees a log.
 * `chain-reader`'s log replay has `log.transactionHash` in hand, but free endpoints serve
 * only a short window near the head, so it accounted for 466 of ~342,000 indexed agents.
 * Every other row arrived through the ID-walk backfill, which reads `tokenURI`/`ownerOf` per
 * id and never touches a log. Adding the hash to `AgentSource` would therefore have written
 * null for 99.9% of the catalogue while implying ingestion maintains the field.
 *
 * So the hash gets its own pass with its own cursor, and ingestion is left alone. This is also
 * why `upsertMany`'s conflict clause must keep listing its columns explicitly: it does not
 * include `registration_tx_hash`, which is what stops a re-ingest from erasing a harvest.
 *
 * Why it needs an archive-capable endpoint
 * ----------------------------------------
 * The registry deployed at block 79,027,268 and the head is past 123,900,000 — some 45M
 * blocks. Measured against the free keyless endpoints, none will serve that history:
 * publicnode (our default) refuses any historical query outright with "Archive requests
 * require a personal token", 1rpc caps the range at 50 blocks, blockrazor at 25, dRPC at
 * 10,000 behind a tight IP limit, and the BNB dataseeds answer "limit exceeded" for a 50k
 * window. NodeReal's free tier serves 50,000-block windows across the full range.
 *
 * Hence `BSC_ARCHIVE_RPC_URL` and an operator-run CLI rather than a scheduled job. Once the
 * history is harvested the cursor sits near the head, and an incremental re-run only asks for
 * recent blocks — which the ordinary endpoint does serve, so keeping coverage current needs no
 * special endpoint at all.
 */

/**
 * Restated rather than imported from `erc8004/abi.ts`.
 *
 * `parseAbiItem` gives viem the literal type that lets it infer `log.args.agentId` as a
 * bigint. Indexing into the exported ABI array widens to a plain object and forces a cast at
 * the call site, which is the kind of cast that would hide a genuine signature mismatch.
 * Identical to `abi.ts` and to chain-reader's copy, and verified against the live topic0
 * `0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a`.
 */
export const REGISTERED_EVENT = parseAbiItem(
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
);

/**
 * The block the identity registry's code first appears at, found by bisecting `eth_getCode`.
 *
 * Hard-coded because it is a fact about an already-deployed contract and cannot change, and
 * re-bisecting costs ~27 archive calls against an endpoint whose generosity is the scarce
 * resource here. `ERC8004_DEPLOY_BLOCK` overrides it, which is what a redeployed registry or
 * a different chain would need.
 */
export const REGISTRY_DEPLOY_BLOCK = 79_027_268;

/** Starting window width. NodeReal's free tier caps `eth_getLogs` at exactly this. */
export const MAX_LOG_WINDOW = 50_000;

/**
 * Rows per UPDATE.
 *
 * Each row contributes three bind parameters against Postgres' limit of 65,535, so the hard
 * ceiling is ~21,800. 2,000 stays far enough below that a registration spike cannot reach it,
 * and keeps a single statement short enough to finish inside the pool's 30s statement timeout.
 */
const ROWS_PER_UPDATE = 2_000;

export interface RegistrationHit {
  agentId: number;
  txHash: string;
  blockNumber: number;
}

const RATE_LIMIT_PHRASES = [
  // NodeReal: "You have reached the maximum API usage limit of public"
  'usage limit',
  'rate limit',
  'too many requests',
  // viem renders NodeReal's throttle as LimitExceededRpcError: "Request exceeds defined limit."
  'exceeds defined limit',
] as const;

/**
 * True when an endpoint is asking us to slow down rather than to ask for less.
 *
 * Checked *before* `looksLikeRangeLimit` and deliberately separate from it, because the two
 * share a JSON-RPC code while calling for opposite responses. NodeReal answers a throttle with
 * -32005, the same code the BNB dataseeds use for an over-wide range, and viem renders both as
 * `LimitExceededRpcError`. Narrowing in response to a throttle makes things worse: the sweep
 * then asks for less data more often, which is the wrong direction and still gets refused.
 *
 * Not theoretical. The first full run walked 39 windows in 28 seconds — roughly 1.4 requests a
 * second against a free shared endpoint — and was cut off. Hence both the backoff and
 * `WINDOW_PAUSE_MS`.
 */
export function looksLikeRateLimit(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return RATE_LIMIT_PHRASES.some((phrase) => message.includes(phrase));
}

/**
 * Pause between windows, so the sweep is a polite client of an endpoint it does not pay for.
 *
 * 899 windows cover the whole history, so this adds under four minutes to a one-off job —
 * cheap insurance against being throttled at window 40 and resuming over and over.
 */
const WINDOW_PAUSE_MS = 250;

/** Attempts before a throttled window gives up. Backs off 1s, 2s, 4s, 8s, 16s. */
const RATE_LIMIT_ATTEMPTS = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const RANGE_LIMIT_PHRASES = [
  // BNB dataseeds, bsc.nodereal.io: -32005 "limit exceeded"
  'limit exceeded',
  // NodeReal /v1: -32602 "exceed maximum block range: 50000"
  'block range',
  // 1rpc: -32602 "eth_getLogs is limited to 0 - 50 blocks range" — note the plural, which is
  // why this is listed separately rather than trusting 'block range' to cover both.
  'blocks range',
  // blockrazor: -32000 "log query range must not exceed 25 blocks"
  'query range',
  // dRPC: 35 "ranges over 10000 blocks are not supported on free plan"
  'ranges over',
  // Result-count and payload caps, which narrowing also fixes.
  'too many results',
  'response size',
  'query returned more than',
  /*
   * A timeout is a width problem here, not a transport problem.
   *
   * NodeReal answers an expensive window with -32602 and `Details: timeout`, which viem renders
   * as `InvalidInputRpcError` — nothing in it mentions a range, so the phrases above all miss
   * it and a full sweep died at 78% in the densest part of the history. Asking for half as many
   * blocks is exactly the right response, and it is also right for our own client-side abort.
   *
   * Safe even when the endpoint is simply down: every attempt halves the window, so a
   * permanently timing-out endpoint reaches a width of 1 and throws rather than looping.
   */
  'timeout',
  'timed out',
] as const;

/**
 * True when an RPC rejected the *width* of the window rather than failing on its own account.
 *
 * Matched on message text because there is no agreed error code for it: the same condition
 * arrives as -32005, -32602, -32000 and a bare 35 depending on the provider. Erring towards a
 * false positive is safe — the window narrows when it need not have, costing time and no
 * correctness — whereas a false negative aborts a sweep that would have succeeded.
 *
 * The phrase list is deliberately literal and sourced from live responses. A tidier regex over
 * the word "range" was the first attempt and it swallowed unrelated failures, which is the
 * worse direction: an auth or archive refusal matched as a range limit sends the sweep down to
 * a one-block window, crawling 45M blocks while reporting progress.
 */
export function looksLikeRangeLimit(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return RANGE_LIMIT_PHRASES.some((phrase) => message.includes(phrase));
}

/**
 * Reads one window of `Registered` logs, halving it until the endpoint accepts the request.
 *
 * Self-calibrating instead of taking a configured chunk size, because the limit is a property
 * of whichever endpoint the operator points at and the measured values span 25 to 50,000. One
 * knob fewer, and it works against an endpoint nobody has measured yet.
 *
 * Returns the width actually used so the caller can both advance its cursor correctly and
 * remember the accepted width rather than rediscovering it on every window.
 */
export async function readRegistrationWindow(
  client: PublicClient,
  address: Hex,
  from: number,
  to: number,
): Promise<{ hits: RegistrationHit[]; width: number }> {
  let end = to;
  let throttled = 0;

  for (;;) {
    try {
      const logs = await client.getLogs({
        address,
        event: REGISTERED_EVENT,
        fromBlock: BigInt(from),
        toBlock: BigInt(end),
      });

      const hits: RegistrationHit[] = [];
      for (const log of logs) {
        const { agentId } = log.args;
        /*
         * Pending logs carry null for hash and block. They cannot occur in a historical
         * range, but the types permit it and a null written as provenance would be worse
         * than no provenance: it reads as "we checked and there is none".
         */
        if (agentId === undefined || log.transactionHash === null || log.blockNumber === null) {
          continue;
        }
        hits.push({
          agentId: Number(agentId),
          txHash: log.transactionHash,
          blockNumber: Number(log.blockNumber),
        });
      }

      return { hits, width: end - from + 1 };
    } catch (error) {
      /*
       * Throttles are waited out, not narrowed. Tested first because the range check would
       * otherwise claim some of them: both arrive as -32005 from different providers.
       */
      if (looksLikeRateLimit(error)) {
        throttled += 1;
        if (throttled > RATE_LIMIT_ATTEMPTS) throw error;
        await sleep(1_000 * 2 ** (throttled - 1));
        continue;
      }

      const width = end - from + 1;
      if (!looksLikeRangeLimit(error) || width <= 1) throw error;
      end = from + Math.max(0, Math.floor(width / 2) - 1);
    }
  }
}

/**
 * Writes harvested hashes onto the agents they belong to. Returns rows actually updated.
 *
 * `coalesce` on the block so a value ingestion already recorded is left alone. The two sources
 * agree, but the stored one is what other rows were sorted against, and rewriting it would
 * churn hundreds of thousands of rows to no effect. The hash itself is written unconditionally
 * so a re-run after a reorg lands the surviving transaction.
 *
 * Hits for agents that are not indexed are silently skipped rather than treated as an error:
 * the registry runs ahead of our catalogue by design, and a `Registered` log for an agent
 * ingestion has not reached yet is early, not wrong. The join on `(chain_id, agent_id)` is
 * what enforces that, which is precisely the behaviour worth a test.
 */
export async function writeRegistrationHits(
  db: Database,
  chainId: number,
  hits: readonly RegistrationHit[],
): Promise<number> {
  let written = 0;

  for (let i = 0; i < hits.length; i += ROWS_PER_UPDATE) {
    const batch = hits.slice(i, i + ROWS_PER_UPDATE);
    const values = sql.join(
      batch.map(
        (hit) => sql`(${hit.agentId}::bigint, ${hit.txHash}::text, ${hit.blockNumber}::bigint)`,
      ),
      sql`, `,
    );

    const result = await db.execute(sql`
      update agents as a
         set registration_tx_hash = v.tx,
             registered_at_block   = coalesce(a.registered_at_block, v.blk),
             updated_at            = now()
        from (values ${values}) as v(agent_id, tx, blk)
       where a.chain_id = ${chainId}
         and a.agent_id = v.agent_id
    `);

    written += (result as unknown as { count?: number }).count ?? 0;
  }

  return written;
}

export interface HarvestOptions {
  db: Database;
  client: PublicClient;
  logger: Logger;
  registryAddress: Hex;
  chainId: number;
  /** `sync_state` row this sweep advances, e.g. `56:identity:tx`. */
  cursorId: string;
  fromBlock: number;
  toBlock: number;
}

export interface HarvestResult {
  hits: number;
  written: number;
  reachedBlock: number;
}

/**
 * Walks the log history between two blocks, writing hashes and advancing the cursor.
 *
 * The cursor is committed after every window, not at the end, so an interruption — a rate
 * limit, a laptop closing, a 45-minute sweep hitting a CI timeout — leaves a resumable
 * position rather than starting over. On failure it records the error on the cursor row and
 * rethrows, so the partial progress survives and `/health` can see a degraded sweep.
 */
export async function harvestRegistrationTxHashes(options: HarvestOptions): Promise<HarvestResult> {
  const { db, client, logger, registryAddress, chainId, cursorId, fromBlock, toBlock } = options;

  let cursor = fromBlock;
  let window = MAX_LOG_WINDOW;
  let hits = 0;
  let written = 0;
  const startedAt = Date.now();
  const total = toBlock - fromBlock + 1;

  try {
    while (cursor <= toBlock) {
      const windowEnd = Math.min(cursor + window - 1, toBlock);
      const page = await readRegistrationWindow(client, registryAddress, cursor, windowEnd);

      /*
       * Remember the width the endpoint accepted so one narrowing is not relearned on every
       * window. Grows back gradually afterwards in case the refusal was load-related rather
       * than a fixed cap.
       */
      window =
        page.width < window ? page.width : Math.min(MAX_LOG_WINDOW, Math.floor(window * 1.5) + 1);

      if (page.hits.length > 0) {
        written += await writeRegistrationHits(db, chainId, page.hits);
        hits += page.hits.length;
      }

      const reached = cursor + page.width - 1;
      const now = new Date();
      await db
        .insert(syncState)
        .values({ id: cursorId, lastBlock: reached, lastRunAt: now, lastSuccessAt: now })
        .onConflictDoUpdate({
          target: syncState.id,
          set: { lastBlock: reached, lastRunAt: now, lastSuccessAt: now, lastError: null },
        });

      logger.info(
        {
          block: reached,
          percent: `${(((reached - fromBlock + 1) / total) * 100).toFixed(1)}%`,
          windowHits: page.hits.length,
          hits,
          written,
          elapsedSec: Math.round((Date.now() - startedAt) / 1_000),
        },
        'registration-tx window done',
      );

      cursor = reached + 1;
      if (cursor <= toBlock) await sleep(WINDOW_PAUSE_MS);
    }

    return { hits, written, reachedBlock: toBlock };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .insert(syncState)
      .values({
        id: cursorId,
        lastBlock: cursor - 1,
        lastRunAt: new Date(),
        lastError: message,
        consecutiveFailures: 1,
      })
      .onConflictDoUpdate({
        target: syncState.id,
        set: {
          lastRunAt: new Date(),
          lastError: message,
          consecutiveFailures: sql`${syncState.consecutiveFailures} + 1`,
        },
      });
    throw error;
  }
}
