import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema } from '../../shared/http/api.schema.js';
import { agentIdParamSchema } from '../agents/agent.schema.js';
import { agentReputationResponseSchema } from './reputation.schema.js';

// Registration is synchronous; the async plugin signature is Fastify's contract.
export const reputationRoutes: FastifyPluginAsyncZod = (app) => {
  const { reputation } = app.services;

  app.get(
    '/agents/:id/reputation',
    {
      schema: {
        operationId: 'getAgentReputation',
        tags: ['reputation'],
        summary: 'Live reputation for one agent',
        description:
          'Reads the ERC-8004 ReputationRegistry directly rather than serving the cached snapshot used by the list endpoint. Falls back to the snapshot if the registry is unreachable and says so in `notes`. `origin` tells you which you got.',
        params: agentIdParamSchema,
        response: {
          200: agentReputationResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) => reputation.getForAgent(request.params.id),
  );

  return Promise.resolve();
};
