import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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
   * Seconds a pooled connection may sit idle before it is closed.
   *
   * Overridable so the advisory-lock regression test can force the condition that broke it.
   * A session lock dies with its connection, and 20 seconds of real time is too long to
   * wait in a test suite, so `ingestion-lock.test.ts` builds a handle with a 1-second
   * timeout and proves the lock survives the pool reaping connections around it.
   */
  idleTimeoutSeconds?: number;
}

export function createDatabase(env: Env, options: DatabaseOptions = {}): DatabaseHandle {
  const sql = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'production' ? 10 : 4,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: 10,
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
      } catch {
        return false;
      }
    },
  };
}
