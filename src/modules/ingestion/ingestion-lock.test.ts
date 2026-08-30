import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../infrastructure/database/client.js';
import { loadEnv } from '../../config/env.js';
import { reputationSweepHasMore } from './sync.js';

/**
 * The advisory lock behind `withIngestionLock`, tested against a real Postgres because the
 * bug it had could not be reproduced any other way.
 *
 * The lock exists because two overlapping backfills once drove the shared cursor backwards
 * 160,000 ids. It was implemented as `db.execute('select pg_try_advisory_lock(...)')`, which
 * looks right and does nothing: a session advisory lock belongs to the connection that took
 * it, `db.execute` borrows an arbitrary pooled connection and returns it immediately, and
 * `idle_timeout: 20` then closes that connection and ends its session. The lock was released
 * twenty seconds into every long run, and `pg_locks` was observed empty while a backlog loop
 * was mid-run, with a second process happily starting alongside it.
 *
 * A unit test against a mocked database would have asserted the right SQL was sent, and
 * passed throughout.
 *
 * Uses its own key rather than the ingestion one. The mechanism is what broke, and testing
 * it on the shared key would mean the suite fails whenever a real sweep or backfill happens
 * to be running, which is exactly when someone is most likely to run the tests.
 */

const TEST_LOCK_KEY = 8_004_999;

let handle: DatabaseHandle;
let other: DatabaseHandle;
let reachable = false;

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined) return;

  const env = loadEnv();
  handle = createDatabase(env);
  // A second handle, so the contention tests model two processes rather than two calls.
  other = createDatabase(env);

  reachable = await handle.ping();
});

afterAll(async () => {
  if (!reachable) return;
  await Promise.all([handle.close(), other.close()]);
});

const guard = (): void => {
  if (!reachable) {
    throw new Error('DATABASE_URL is not reachable. Start Postgres before `pnpm test`.');
  }
};

/** Counts the test lock from a different pool, which is the only view that matters. */
async function lockIsHeld(): Promise<boolean> {
  const rows = await other.db.execute<{ objid: string }>(
    `select objid from pg_locks where locktype = 'advisory' and objid = ${String(TEST_LOCK_KEY)}`,
  );
  return rows.length === 1;
}

describe('withAdvisoryLock', () => {
  it('is visible to another connection while the work runs', async () => {
    guard();

    const held = await handle.withAdvisoryLock(TEST_LOCK_KEY, lockIsHeld);
    expect(held).toBe(true);
  });

  it('survives the pool reaping idle connections', async () => {
    /*
     * The regression, made deterministic.
     *
     * Every other test here passes against the broken implementation, because taking the
     * lock through the pool does hold it for a while: the connection goes back to the pool
     * still carrying its session, and the lock only dies when the pool closes it. In
     * production that was `idle_timeout: 20`, so the lock quietly vanished twenty seconds
     * into every multi-hour run and nothing noticed.
     *
     * This handle uses a 1-second timeout and the body waits it out, so the pool reaps
     * connections mid-work. `reserve()` keeps its connection checked out and therefore never
     * idle. Verified: against the pooled version this assertion fails with 0 locks held.
     */
    guard();

    const shortLived = createDatabase(loadEnv(), { idleTimeoutSeconds: 1 });

    try {
      const stillHeld = await shortLived.withAdvisoryLock(TEST_LOCK_KEY, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        return lockIsHeld();
      });

      expect(stillHeld).toBe(true);
    } finally {
      await shortLived.close();
    }
  }, 15_000);

  it('refuses a second holder instead of running alongside it', async () => {
    guard();

    let innerRan = false;

    const outer = await handle.withAdvisoryLock(TEST_LOCK_KEY, async () => {
      return other.withAdvisoryLock(TEST_LOCK_KEY, () => {
        innerRan = true;
        return Promise.resolve('inner');
      });
    });

    // Null, not 'inner': the second attempt must decline rather than race the cursor.
    expect(outer).toBeNull();
    expect(innerRan).toBe(false);
  });

  it('releases the lock when the work finishes', async () => {
    guard();

    await handle.withAdvisoryLock(TEST_LOCK_KEY, () => Promise.resolve('first'));
    const second = await handle.withAdvisoryLock(TEST_LOCK_KEY, () => Promise.resolve('second'));

    expect(second).toBe('second');
  });

  it('releases the lock when the work throws', async () => {
    guard();

    await expect(
      handle.withAdvisoryLock(TEST_LOCK_KEY, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    // A failed pass must not lock ingestion out until someone restarts Postgres.
    const after = await handle.withAdvisoryLock(TEST_LOCK_KEY, () => Promise.resolve('recovered'));
    expect(after).toBe('recovered');
  });

  it('does not leak the reserved connection across runs', async () => {
    /*
     * `reserve()` takes a connection out of the pool and only `release()` puts it back. The
     * pool is 4 in development, so a leak exhausts it and the fifth run hangs rather than
     * failing loudly, which is the worst way for this to break.
     */
    guard();

    for (let i = 0; i < 6; i += 1) {
      const result = await handle.withAdvisoryLock(TEST_LOCK_KEY, () => Promise.resolve(i));
      expect(result).toBe(i);
    }
  });
});

describe('reputationSweepHasMore', () => {
  it('continues while agents remain unswept', () => {
    expect(reputationSweepHasMore({ remaining: 1 })).toBe(true);
  });

  it('stops when the catalogue is exhausted', () => {
    expect(reputationSweepHasMore({ remaining: 0 })).toBe(false);
  });
});
