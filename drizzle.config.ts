import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs outside the app, so it reads DATABASE_URL directly rather
 * than through src/config/env.ts (which pulls in the whole runtime config).
 *
 * drizzle-kit does not accept Node's --env-file flag, so the file is loaded here.
 * Node's built-in loader is used rather than adding a dotenv dependency.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env — expected in CI and production, where the platform injects vars.
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit. See .env.example.');
}

export default defineConfig({
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
