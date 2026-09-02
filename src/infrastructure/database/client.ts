import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /**
   * Takes a Postgres session-level advisory lock and holds it for the duration of `work`.
   *
   * Lives here, on the raw client, because it cannot be done through the pool. A session
   * advisory lock belongs to the connection that took it, and `db.execute` borrows an
   * arbitrary pooled connection and hands it straight back. With `idle_timeout: 20` that
   * connection is closed twenty seconds later, its session ends, and the lock is silently
   * released while the job that thought it held one is still running.
   *
   * That is not theoretical: with a metadata backlog loop mid-run, `pg_locks` showed no
   * advisory lock at all, and a second ingestion process started alongside it without
   * complaint. The lock was added after two overlapping backfills drove the cursor
   * backwards 160,000 ids, and it had never actually prevented that.
   *
   * `reserve()` pulls one connection out of the pool and keeps it, so the session outlives
   * the statement. Released explicitly, and also by the connection closing, so a crashed
   * run cannot lock ingestion out permanently.
   *
   * Returns null without running `work` when another process holds the lock.
   */
  withAdvisoryLock: <T>(key: number, work: () => Promise<T>) => Promise<T | null>;
  /** Closes the pool. Called from the server's shutdown hook. */
  close: () => Promise<void>;
  /** Cheap liveness probe used by /health. */
  ping: () => Promise<boolean>;
}

export interface DatabaseOptions {
  /**
   * Where a failed liveness probe reports itself.
   *
   * Optional so tests can build a handle without one, and worth having because the alternative
   * was silence: `ping` swallowed its error, so `/health` could say `database: down` while the
   * logs said nothing at all about why. Diagnosing a deployment then meant guessing between a
   * wrong password, a missing SSL parameter and an unreachable host, none of which look
   * different from the outside.
   */
  logger?: Logger;
  /**
   * Seconds a pooled connection may sit idle before it is closed.
   *
   * Overridable so the advisory-lock regression test can force the condition that broke it.
   * A session lock dies with its connection, and 20 seconds of real time is too long to
   * wait in a test suite, so `ingestion-lock.test.ts` builds a handle with a 1-second
   * timeout and proves the lock survives the pool reaping connections around it.
   */
  idleTimeoutSeconds?: number;
  /**
   * Milliseconds a single statement may run before Postgres aborts it.
   *
   * Overridable for the same reason as above: the default is far too long to wait in a test,
   * so `statement-timeout.test.ts` sets a small one and proves a runaway query is cancelled.
   */
  statementTimeoutMs?: number;
}

/**
 * Ceiling on a single statement.
 *
 * Without one, a query can run until the connection dies, holding a slot in a pool of ten.
 * Enough of those and every later request queues for a connection, including `/health`,
 * whose failure Render reads as a dead process and answers by restarting it — which frees
 * nothing, because the queries were the database's work, not the web process's.
 *
 * Thirty seconds, not the two or three a request budget suggests, because it is a stop for a
 * runaway rather than a latency target. The slowest legitimate query here is the landing
 * page's stats aggregate at 9.4s uncached, and a deliberately broad search count is around
 * 10s; a tighter ceiling would start failing work that is merely slow on a 0.1 CPU instance.
 * Anything past thirty seconds is not slow, it is stuck.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Host and database from a connection string, for logging.
 *
 * Parsed rather than logged whole, because the string carries a password. Says which server was
 * being dialled without putting the credential in a log aggregator.
 */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

export function createDatabase(env: Env, options: DatabaseOptions = {}): DatabaseHandle {
  const sql = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'production' ? 10 : 4,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: 10,
    // Server-side ceiling, set per connection. Enforced by Postgres rather than by us, so it
    // still applies to a query whose client has already given up and gone away.
    connection: {
      statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    },
    // Silences postgres.js' own notice logging; ours goes through pino.
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    withAdvisoryLock: async <T>(key: number, work: () => Promise<T>): Promise<T | null> => {
      const reserved = await sql.reserve();

      try {
        const [row] = await reserved<{ locked: boolean }[]>`
          select pg_try_advisory_lock(${key}) as locked
        `;
        if (row?.locked !== true) return null;

        try {
          return await work();
        } finally {
          await reserved`select pg_advisory_unlock(${key})`;
        }
      } finally {
        // Back to the pool. Without this the connection is leaked for the process lifetime.
        reserved.release();
      }
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    ping: async () => {
      try {
        await sql`select 1`;
        return true;
      } catch (error) {
        /*
         * Logged, not swallowed. `/health` reports a boolean because that is all a status page
         * needs, but the boolean is useless to whoever has to fix it: a wrong password, a
         * missing `sslmode=require` and a host that does not resolve all render as
         * `database: down`.
         *
         * The driver's `code` is the useful half — 28P01 is authentication, 28000 covers the
         * insecure-connection refusal, ENOTFOUND is DNS — so it is surfaced separately rather
         * than left inside a message string.
         */
        const detail = error as { code?: string; message?: string };
        options.logger?.error(
          { err: error, code: detail.code, host: hostOf(env.DATABASE_URL) },
          'database ping failed',
        );
        return false;
      }
    },
  };
}
