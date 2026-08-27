import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '../../config/env.js';
import { createDatabase } from './client.js';

/**
 * Applies pending Drizzle migrations, then exits. Kept as a script rather than
 * running on server boot so a rolling deploy cannot have two instances
 * migrating concurrently.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const handle = createDatabase(env);

  try {
    await migrate(handle.db, { migrationsFolder: './drizzle' });
    process.stdout.write('migrations applied\n');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
