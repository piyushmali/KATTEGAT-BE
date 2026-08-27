import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponseSchema } from '../../shared/http/api.schema.js';
import { searchQuerySchema, searchResponseSchema } from './search.schema.js';

// Registration is synchronous; the async plugin signature is Fastify's contract.
export const searchRoutes: FastifyPluginAsyncZod = (app) => {
  const { search } = app.services;

  app.get(
    '/search',
    {
      schema: {
        operationId: 'searchAgents',
        tags: ['search'],
        summary: 'Natural-language agent search',
        description:
          'Resolves a plain-language query into structured filters and returns the matching agents. The interpretation is returned alongside the results — `meta.interpretation.filters` is the query that actually ran and `meta.interpretation.explanation` says how it was derived, so a user can correct a misreading instead of guessing. Use GET /agents directly when you already know the filters.',
        querystring: searchQuerySchema,
        response: {
          200: searchResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => search.search(request.query),
  );

  return Promise.resolve();
};
