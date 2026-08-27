import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../../config/env.js';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Closes the pool. Called from the server's shutdown hook. */
  close: () => Promise<void>;
  /** Cheap liveness probe used by /health. */
  ping: () => Promise<boolean>;
}

export function createDatabase(env: Env): DatabaseHandle {
  const sql = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'production' ? 10 : 4,
    idle_timeout: 20,
    connect_timeout: 10,
    // Silences postgres.js' own notice logging; ours goes through pino.
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema });

  return {
    db,
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
