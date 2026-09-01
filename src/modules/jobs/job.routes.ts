import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/api.schema.js';
import { agentIdParamSchema } from '../agents/agent.schema.js';
import {
  recordJobBodySchema,
  recordJobResponseSchema,
} from '../hiring/hiring.schema.js';
import { listAgentJobsResponseSchema } from './job.schema.js';

/**
 * Job routes.
 *
 * Note what the POST is not. It does not commission work: funding a job moves the client's own
 * tokens, so those calls are signed in their browser against the escrow kernel directly. This
 * service holds no key that could hire on anyone's behalf, so the write here is a report about a
 * job that already exists, verified against the kernel before it is believed.
 *
 * The POST delegates to the hiring service rather than the jobs service, because a hire is
 * verified against the chain the user's session lives on while the GET serves the chain the
 * catalogue was indexed from. Same path, since in production they are the same chain.
 */
export const jobRoutes: FastifyPluginAsyncZod = (app) => {
  const { hiring, jobs } = app.services;

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

  app.post(
    '/agents/:id/jobs',
    {
      schema: {
        operationId: 'recordAgentJob',
        tags: ['jobs'],
        summary: 'Record an escrowed job the user funded in their browser',
        description:
          'Reports an ERC-8183 job that already exists on chain. The only field is the job id: budget, client, provider and status are all read from the kernel, because accepting them from a client would be taking claims about money on trust. Returns 400 when the job does not exist, when it names a different provider than this agent, or when its escrow was never funded. `counts_as_evidence` is false when the session chain is not the chain the catalogue was indexed from, which is the case on testnet.',
        params: agentIdParamSchema,
        body: recordJobBodySchema,
        response: {
          201: recordJobResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await hiring.recordJob(request.params.id, request.body);
      return reply.code(201).send(result);
    },
  );

  return Promise.resolve();
};
