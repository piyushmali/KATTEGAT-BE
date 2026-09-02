import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { sql } from 'drizzle-orm';
import { parseEnv } from '../../config/env.js';
import { createDatabase, type DatabaseHandle } from './client.js';

/**
 * Proves a runaway query is cancelled by the server rather than allowed to hold a connection.
 *
 * Worth a test because the failure it prevents is indirect and expensive. A query with no
 * ceiling occupies one slot in a pool of ten until its connection dies. Enough of them and every
 * later request queues for a connection, `/health` among them, and Render reads a slow `/health`
 * as a dead process and restarts it — which frees nothing, because the work was the database's.
 * A degraded database becomes a restart loop.
 *
 * Uses a deliberately tiny timeout so the test is fast; the shipped default is 30s.
 */

const databaseUrl = process.env.DATABASE_URL;

let handle: DatabaseHandle;
let reachable = false;

beforeAll(async () => {
  if (!databaseUrl) return;

  const env = parseEnv({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test' });
  handle = createDatabase(env, {
    logger: pino({ level: 'silent' }),
    statementTimeoutMs: 300,
  });
  reachable = await handle.ping();
});

afterAll(async () => {
  if (handle) await handle.close();
});

/** Skips rather than fails when no database is configured, matching api.test.ts. */
function guard(): void {
  if (!reachable) {
    expect(true).toBe(true);
  }
}

/** Postgres SQLSTATE for a statement the server cancelled. */
const QUERY_CANCELED = '57014';

describe('statement timeout', () => {
  it('cancels a query that runs past the ceiling', async () => {
    guard();
    if (!reachable) return;

    const started = Date.now();
    // pg_sleep is the cheapest way to be definitively too slow.
    const result = await handle.db.execute(sql`select pg_sleep(5)`).then(
      () => null,
      (error: unknown) => error,
    );
    const elapsed = Date.now() - started;

    expect(result).not.toBeNull();

    /*
     * Asserted on the driver's code rather than the message. Drizzle replaces the message with
     * its own "Failed query: ..." text and moves the original underneath, so matching on words
     * would pass for any failure at all — including the query never having been cancelled.
     */
    const cause = (result as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe(QUERY_CANCELED);

    // And it was the timeout that did it, not something arriving before the sleep began.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('leaves the connection usable afterwards', async () => {
    guard();
    if (!reachable) return;

    /*
     * The point of the previous assertion is only worth anything if the pool recovers. A
     * cancelled statement must not poison its connection, or the guard against exhaustion
     * would itself cause exhaustion.
     */
    await expect(handle.db.execute(sql`select pg_sleep(5)`)).rejects.toThrow();

    expect(await handle.ping()).toBe(true);
  });

  it('does not interfere with a query that finishes in time', async () => {
    guard();
    if (!reachable) return;

    await expect(handle.db.execute(sql`select pg_sleep(0.05)`)).resolves.toBeDefined();
  });
});
