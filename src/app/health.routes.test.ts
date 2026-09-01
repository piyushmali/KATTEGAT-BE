import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseEnv } from '../config/env.js';
import type { Database, DatabaseHandle } from '../infrastructure/database/client.js';
import { buildServer } from './server.js';
import type { AppInstance } from './app-instance.js';

/**
 * One invariant, and it is a billing invariant rather than a correctness one:
 * `/live` must answer without touching the database.
 *
 * Worth a test of its own because breaking it is invisible. Adding a query to
 * `/live` would keep every assertion elsewhere green, keep the endpoint
 * answering 200, and show up weeks later as a database that suspended itself
 * for the rest of the month. The keepalive calls this every ten minutes
 * forever, so a managed Postgres that bills awake time never gets to sleep and
 * the ping alone can exhaust the monthly compute allowance.
 *
 * That is not hypothetical: it is what took this deployment down. The keepalive
 * pinged `/health`, which runs two queries, and the database's compute was held
 * awake continuously by the thing meant to be watching it.
 *
 * Runs without Postgres, deliberately. The database is a stub that records use,
 * so the test states the requirement directly instead of inferring it from
 * timings, and it still runs on a machine with no database at all.
 */

let app: AppInstance;
/** Incremented by any use of the connection, from either endpoint. */
let touches = 0;

beforeAll(async () => {
  const env = parseEnv({
    // Never dialled; the handle below is injected in its place.
    DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });

  /*
   * Records rather than throws on property access, because `buildServer` hands this
   * to every repository at construction and a throwing proxy would fail before any
   * request. Calling what it returns does throw, so a query that slips into `/live`
   * fails loudly rather than passing silently.
   */
  const db = new Proxy({} as Database, {
    get: (_target, property) => {
      touches += 1;
      return () => {
        throw new Error(`database used unexpectedly: ${String(property)}`);
      };
    },
  });

  const database: DatabaseHandle = {
    db,
    withAdvisoryLock: () => {
      touches += 1;
      return Promise.resolve(null);
    },
    close: () => Promise.resolve(),
    ping: () => {
      touches += 1;
      // False, so `/health` reports the database down and returns before it
      // reaches a query. Lets this run with nothing listening on 5432.
      return Promise.resolve(false);
    },
  };

  app = await buildServer({ env, logger: pino({ level: 'silent' }), database });
  await app.ready();

  // Construction legitimately passes the handle around; only use during a
  // request is the subject here.
  touches = 0;
});

afterAll(async () => {
  await app?.close();
});

describe('GET /live', () => {
  it('answers 200 without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    expect(touches).toBe(0);
  });

  it('reports uptime, so a restart loop is visible to the pinger', async () => {
    const response = await app.inject({ method: 'GET', url: '/live' });

    expect(response.json<{ uptime_seconds: number }>().uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(touches).toBe(0);
  });
});

describe('GET /health', () => {
  it('does touch the database, which is why the keepalive uses /live instead', async () => {
    touches = 0;

    const response = await app.inject({ method: 'GET', url: '/health' });

    // 503 because the stubbed ping reports down. The subject is the cost, not the code.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { database: 'down' } });
    expect(touches).toBeGreaterThan(0);
  });
});
