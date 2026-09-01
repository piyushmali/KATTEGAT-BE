import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/client.js';
import { createStatsService } from './stats.service.js';

/**
 * Covers the caching, not the SQL. The aggregate itself is exercised against real Postgres by
 * the API contract tests; what needs stating here is the behaviour around it, because it is
 * timing-dependent and silently degrades.
 *
 * The point of stale-while-revalidate is that no visitor waits for the 9.4s scan except the very
 * first one. A regression to plain expiry would keep every assertion about the numbers green and
 * only show up as one slow request per minute, which is exactly the kind of thing that gets
 * noticed during a demo and not before.
 */

/** Minimal stand-in for the drizzle chain `read()` uses: `db.select({...}).from(...)`. */
function fakeDb(onRead: () => Promise<Array<Record<string, unknown>>>): Database {
  return {
    select: () => ({ from: () => onRead() }),
  } as unknown as Database;
}

/** Lets queued promise callbacks run without advancing the faked clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const TTL_MS = 60_000;

let reads = 0;
let failNext = false;

function service() {
  return createStatsService(
    fakeDb(() => {
      reads += 1;
      if (failNext) return Promise.reject(new Error('database unavailable'));
      // indexedAgents doubles as a serial number, so a response can be traced to its read.
      return Promise.resolve([{ indexedAgents: reads }]);
    }),
  );
}

beforeEach(() => {
  reads = 0;
  failNext = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stats caching', () => {
  it('reads once for the first call and reuses it inside the TTL', async () => {
    const stats = service();

    const first = await stats.ecosystem();
    const second = await stats.ecosystem();

    expect(first.data.indexed_agents).toBe(1);
    expect(second.data.indexed_agents).toBe(1);
    expect(reads).toBe(1);
  });

  it('shares one query between concurrent first callers', async () => {
    const stats = service();

    const [a, b, c] = await Promise.all([
      stats.ecosystem(),
      stats.ecosystem(),
      stats.ecosystem(),
    ]);

    expect(reads).toBe(1);
    expect([a.data.indexed_agents, b.data.indexed_agents, c.data.indexed_agents]).toEqual([1, 1, 1]);
  });

  it('serves the stale reading immediately once the TTL passes, and refreshes behind it', async () => {
    const stats = service();
    await stats.ecosystem();

    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1));

    // The whole point: this returns the previous value rather than waiting for the refresh.
    const stale = await stats.ecosystem();
    expect(stale.data.indexed_agents).toBe(1);

    await flush();
    expect(reads).toBe(2);

    const fresh = await stats.ecosystem();
    expect(fresh.data.indexed_agents).toBe(2);
  });

  it('does not start a second refresh while one is in flight', async () => {
    const stats = service();
    await stats.ecosystem();

    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1));

    await Promise.all([stats.ecosystem(), stats.ecosystem(), stats.ecosystem()]);
    await flush();

    // One background refresh, not three.
    expect(reads).toBe(2);
  });

  it('keeps serving the last good reading when a background refresh fails', async () => {
    const stats = service();
    await stats.ecosystem();

    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1));
    failNext = true;

    const afterFailure = await stats.ecosystem();
    await flush();

    // Stat cards keep their numbers rather than going blank or throwing.
    expect(afterFailure.data.indexed_agents).toBe(1);
    expect(await stats.ecosystem().then((r) => r.data.indexed_agents)).toBe(1);
  });

  it('propagates the error when the very first read fails, since there is nothing to serve', async () => {
    failNext = true;
    const stats = service();

    await expect(stats.ecosystem()).rejects.toThrow('database unavailable');

    // And recovers rather than caching the rejection.
    failNext = false;
    expect((await stats.ecosystem()).data.indexed_agents).toBe(2);
  });
});
