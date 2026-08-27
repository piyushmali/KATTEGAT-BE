import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema } from '../../shared/http/api.schema.js';
import {
  agentDetailResponseSchema,
  agentIdParamSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
} from './agent.schema.js';

/**
 * Agent routes.
 *
 * Handlers are one line each: the schema validates declaratively, the service
 * does the work. Anything longer than a delegation belongs in the service.
 */
// Registration is synchronous; the async plugin signature is Fastify's contract,
// so the promise is returned explicitly rather than via `async`.
export const agentRoutes: FastifyPluginAsyncZod = (app) => {
  const { agents } = app.services;

  app.get(
    '/agents',
    {
      schema: {
        operationId: 'listAgents',
        tags: ['agents'],
        summary: 'Search and browse indexed agents',
        description:
          'Paginated agent discovery. Filters compose with AND. Categories are derived by KATTEGAT (ERC-8004 has no category field); reputation is read from the ERC-8004 ReputationRegistry.',
        querystring: listAgentsQuerySchema,
        response: {
          200: listAgentsResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => agents.list(request.query),
  );

  app.get(
    '/agents/:id',
    {
      schema: {
        operationId: 'getAgent',
        tags: ['agents'],
        summary: 'Fetch one agent by composite id',
        description: 'The id is `<chainId>:<agentId>`, for example `56:309393`.',
        params: agentIdParamSchema,
        response: {
          200: agentDetailResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => agents.getById(request.params.id),
  );

  return Promise.resolve();
};
