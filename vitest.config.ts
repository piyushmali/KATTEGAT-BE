import { defineConfig } from 'vitest/config';

// vitest does not forward Node's --env-file flag, so .env is loaded here to keep
// `pnpm test` working without the caller sourcing it first.
try {
  process.loadEnvFile('.env');
} catch {
  // Absent in CI, where the platform injects variables.
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // api.test.ts talks to a real Postgres; unit specs stay in single digits of ms.
    testTimeout: 15_000,
    // The API suite shares one database, so files must not run concurrently.
    fileParallelism: false,
  },
});
