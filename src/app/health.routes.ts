import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { syncState } from '../infrastructure/database/schema.js';

/**
 * Liveness and readiness, deliberately split.
 *
 * `/health` is intentionally more than `{ ok: true }`: it reports the database
 * and the last ingestion result, because the failure this backend is most likely
 * to hit is "chain sync has been quietly failing for an hour" — which a naive
 * health check reports as perfectly healthy.
 *
 * `/live` exists because that richness has a running cost. The host sleeps when
 * idle, so something must ping it continuously to keep it warm, and every
 * `/health` ping runs two queries. On a managed Postgres that suspends its
 * compute when idle and bills the awake time against a monthly allowance, a
 * ping every ten minutes never lets it sleep, and the keepalive quietly spends
 * the database's whole monthly budget on proving the web process is up.
 *
 * So the two questions get two endpoints. "Is the process up?" is answered
 * without a single query, which is what a keepalive actually needs to ask. "Is
 * the system serving correct data?" still costs queries, and is asked on a
 * schedule that can afford them.
 */

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptime_seconds: z.number(),
  checks: z.object({
    database: z.enum(['up', 'down']),
    ingestion: z.object({
      status: z.enum(['ok', 'stale', 'failing', 'never_run']),
      last_success_at: z.string().nullable(),
      last_block: z.number().nullable(),
      consecutive_failures: z.number(),
    }),
  }),
});

/** Above this, ingestion is reported as failing rather than merely stale. */
const FAILURE_THRESHOLD = 3;

const liveResponseSchema = z.object({
  status: z.literal('ok'),
  uptime_seconds: z.number(),
});

export const healthRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/live',
    {
      schema: {
        operationId: 'live',
        tags: ['system'],
        summary: 'Process liveness, touching no dependencies',
        response: { 200: liveResponseSchema },
      },
      config: { rateLimit: false },
    },
    // Deliberately queries nothing. Answering this must never wake the database,
    // because a keepalive calls it every few minutes forever. See the note above.
    () => ({
      status: 'ok' as const,
      uptime_seconds: Math.round(process.uptime()),
    }),
  );

  app.get(
    '/health',
    {
      schema: {
        operationId: 'health',
        tags: ['system'],
        summary: 'Service health, including ingestion freshness',
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
      config: { rateLimit: false },
    },
    async (_request, reply) => {
      const databaseUp = await app.database.ping();

      let ingestion: z.infer<typeof healthResponseSchema>['checks']['ingestion'] = {
        status: 'never_run',
        last_success_at: null,
        last_block: null,
        consecutive_failures: 0,
      };

      if (databaseUp) {
        const rows = await app.database.db.select().from(syncState).limit(1);
        const row = rows[0];
        if (row) {
          const failures = row.consecutiveFailures;
          ingestion = {
            status:
              failures >= FAILURE_THRESHOLD
                ? 'failing'
                : row.lastSuccessAt === null
                  ? 'never_run'
                  : failures > 0
                    ? 'stale'
                    : 'ok',
            last_success_at: row.lastSuccessAt?.toISOString() ?? null,
            last_block: row.lastBlock,
            consecutive_failures: failures,
          };
        }
      }

      // The database is the only hard dependency for serving reads. A failing
      // sync degrades freshness, so it is reported but does not fail readiness.
      const status = databaseUp ? 'ok' : 'degraded';

      return reply.status(databaseUp ? 200 : 503).send({
        status,
        version: app.appVersion,
        uptime_seconds: Math.round(process.uptime()),
        checks: {
          database: databaseUp ? 'up' : 'down',
          ingestion,
        },
      });
    },
  );

  return Promise.resolve();
};
