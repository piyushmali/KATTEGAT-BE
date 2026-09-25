import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseEnv } from '../../config/env.js';
import { createDatabase, type DatabaseHandle } from '../../infrastructure/database/client.js';
import { agents } from '../../infrastructure/database/schema.js';
import {
  looksLikeRangeLimit,
  looksLikeRateLimit,
  writeRegistrationHits,
} from './registration-tx.js';

/**
 * Guards the two parts of the sweep that fail silently rather than loudly.
 *
 * `writeRegistrationHits` issues one `UPDATE ... FROM (VALUES ...)` across the whole
 * catalogue. If its join were wrong it would not throw — it would attach the wrong
 * provenance to hundreds of thousands of agents, or quietly overwrite a block number other
 * rows are sorted by, and the run would report success either way. That is the case for
 * testing the SQL against a real Postgres rather than a mock: the join is the logic.
 *
 * `looksLikeRangeLimit` decides whether a failed window gets narrowed or aborts the sweep, from
 * message text alone because providers agree on no error code for it. Cheap to pin down, and
 * the strings came from live responses.
 */

const TEST_CHAIN = 31_338;
const PLAIN = `${String(TEST_CHAIN)}:1`;
const HAS_BLOCK = `${String(TEST_CHAIN)}:2`;
const OTHER_CHAIN = `${String(TEST_CHAIN + 1)}:1`;

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

const databaseUrl = process.env.DATABASE_URL;

let handle: DatabaseHandle;
let reachable = false;

beforeAll(async () => {
  if (!databaseUrl) return;

  const env = parseEnv({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test' });
  handle = createDatabase(env);
  reachable = await handle.ping();
  if (!reachable) {
    await handle.close();
    return;
  }

  const base = {
    ownerAddress: '0x1111111111111111111111111111111111111111',
    name: 'Fixture',
    source: 'test',
  };

  await handle.db.insert(agents).values([
    { ...base, id: PLAIN, chainId: TEST_CHAIN, agentId: 1 },
    // Already carries a block from log replay, so the coalesce has something to protect.
    { ...base, id: HAS_BLOCK, chainId: TEST_CHAIN, agentId: 2, registeredAtBlock: 111 },
    // Same agent id on a different chain. A join that forgot chain_id would hit this.
    { ...base, id: OTHER_CHAIN, chainId: TEST_CHAIN + 1, agentId: 1 },
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await handle.db.delete(agents).where(eq(agents.chainId, TEST_CHAIN));
  await handle.db.delete(agents).where(eq(agents.chainId, TEST_CHAIN + 1));
  await handle.close();
});

async function read(id: string) {
  const row = await handle.db.query.agents.findFirst({ where: (a, { eq: is }) => is(a.id, id) });
  return { txHash: row?.registrationTxHash ?? null, block: row?.registeredAtBlock ?? null };
}

describe('writeRegistrationHits', () => {
  it('writes the hash, fills a missing block and leaves an existing one alone', async () => {
    if (!reachable) return;

    const written = await writeRegistrationHits(handle.db, TEST_CHAIN, [
      { agentId: 1, txHash: HASH_A, blockNumber: 500 },
      { agentId: 2, txHash: HASH_B, blockNumber: 999 },
    ]);

    expect(written).toBe(2);
    expect(await read(PLAIN)).toStrictEqual({ txHash: HASH_A, block: 500 });
    /*
     * The block stays 111. Ingestion recorded it and other rows are ordered against it, so
     * the sweep contributes provenance without churning a column it does not own.
     */
    expect(await read(HAS_BLOCK)).toStrictEqual({ txHash: HASH_B, block: 111 });
  });

  it('does not touch the same agent id on another chain', async () => {
    if (!reachable) return;

    await writeRegistrationHits(handle.db, TEST_CHAIN, [
      { agentId: 1, txHash: HASH_C, blockNumber: 700 },
    ]);

    expect((await read(OTHER_CHAIN)).txHash).toBeNull();
  });

  it('ignores hits for agents that are not indexed yet', async () => {
    if (!reachable) return;

    // The registry runs ahead of the catalogue, so this is routine, not an error.
    const written = await writeRegistrationHits(handle.db, TEST_CHAIN, [
      { agentId: 987_654, txHash: HASH_A, blockNumber: 1 },
    ]);

    expect(written).toBe(0);
  });

  it('counts only the rows it matched when a batch is part known, part unknown', async () => {
    if (!reachable) return;

    const written = await writeRegistrationHits(handle.db, TEST_CHAIN, [
      { agentId: 1, txHash: HASH_A, blockNumber: 500 },
      { agentId: 987_654, txHash: HASH_B, blockNumber: 2 },
    ]);

    expect(written).toBe(1);
  });

  it('is a no-op for an empty batch rather than building invalid SQL', async () => {
    if (!reachable) return;

    // `(values )` with no rows is a syntax error, so the loop must not run at all.
    await expect(writeRegistrationHits(handle.db, TEST_CHAIN, [])).resolves.toBe(0);
  });

  it('leaves agents outside the batch untouched', async () => {
    if (!reachable) return;

    const before = await read(HAS_BLOCK);
    await writeRegistrationHits(handle.db, TEST_CHAIN, [
      { agentId: 1, txHash: HASH_A, blockNumber: 500 },
    ]);
    expect(await read(HAS_BLOCK)).toStrictEqual(before);
  });
});

describe('looksLikeRangeLimit', () => {
  it('recognises the refusals the free BSC endpoints actually return', () => {
    // Captured verbatim from live responses while measuring providers.
    for (const message of [
      'limit exceeded',
      'exceed maximum block range: 50000',
      'ranges over 10000 blocks are not supported on free plan',
      'eth_getLogs is limited to 0 - 50 blocks range',
      'log query range must not exceed 25 blocks',
      /*
       * NodeReal's answer to a window that is too expensive to serve. Mentions no range at
       * all, which is why it needs its own case: without it a sweep dies in the densest part
       * of the history, which is what happened at 78% on the first full run.
       */
      'Missing or invalid parameters. Details: timeout',
    ]) {
      expect(looksLikeRangeLimit(new Error(message))).toBe(true);
    }
  });

  it('does not mistake an unrelated failure for a window that is too wide', () => {
    /*
     * The consequence of a false positive here is a sweep that halves its window to 1 block
     * and crawls 45M blocks one at a time, reporting success the whole way. Archive refusals
     * and auth failures must abort instead.
     */
    for (const message of [
      'Archive requests require a personal token',
      'fetch failed',
      'invalid project id',
    ]) {
      expect(looksLikeRangeLimit(new Error(message))).toBe(false);
    }
  });
});

describe('looksLikeRateLimit', () => {
  /*
   * The distinction that matters most in this file. A throttle and an over-wide range both
   * arrive as JSON-RPC -32005 and both surface as viem's `LimitExceededRpcError`, but one
   * wants a wait and the other wants a smaller window. Narrowing a throttled window makes it
   * worse — more requests for less data each — so these two predicates must not overlap on
   * any message either provider actually sends.
   */
  const throttles = [
    'Request exceeds defined limit. Details: You have reached the maximum API usage limit of public',
    'You reached Public endpoint rate limit, please upgrade to paid plan',
    'HTTP request failed. Status: 429 Too Many Requests',
  ];

  it('recognises a throttle', () => {
    for (const message of throttles) {
      expect(looksLikeRateLimit(new Error(message))).toBe(true);
    }
  });

  it('is not triggered by a range refusal, which needs narrowing instead of waiting', () => {
    for (const message of [
      'limit exceeded',
      'exceed maximum block range: 50000',
      'ranges over 10000 blocks are not supported on free plan',
      'log query range must not exceed 25 blocks',
    ]) {
      expect(looksLikeRateLimit(new Error(message))).toBe(false);
    }
  });

  it('is not triggered by an archive refusal, which is fatal to the sweep', () => {
    // Waiting this one out would loop forever against our default endpoint.
    expect(looksLikeRateLimit(new Error('Archive requests require a personal token'))).toBe(false);
  });

  it('handles a thrown non-Error without crashing the sweep', () => {
    expect(looksLikeRangeLimit('limit exceeded')).toBe(true);
    expect(looksLikeRangeLimit(null)).toBe(false);
  });
});
