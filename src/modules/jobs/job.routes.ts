import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/api.schema.js';
import { agentIdParamSchema } from '../agents/agent.schema.js';
import { listAgentJobsResponseSchema } from './job.schema.js';

/**
 * Job routes.
 *
 * Read-only, and there is no write endpoint here by design. Funding a job moves the client's
 * own tokens, so the calls are signed in their browser against the escrow kernel directly. This
 * service never holds a key that could commission work on someone's behalf.
 */
export const jobRoutes: FastifyPluginAsyncZod = (app) => {
  const { jobs } = app.services;

  app.get(
    '/agents/:id/jobs',
    {
      schema: {
        operationId: 'listAgentJobs',
        tags: ['jobs'],
        summary: 'ERC-8183 jobs this agent was hired for',
        description:
          'Escrowed work read from the AgenticCommerce kernel, newest first. A job here is a budget that was locked on chain against this agent, not a review. `meta.summary` separates jobs that were merely created from jobs that were actually funded, because anyone can name any provider without paying. `meta.commerce_address` and `meta.dispute_window_seconds` are included so every figure can be checked against the explorer independently.',
        params: agentIdParamSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
        response: {
          200: listAgentJobsResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => jobs.listForAgent(request.params.id, request.query.limit),
  );

  return Promise.resolve();
};
