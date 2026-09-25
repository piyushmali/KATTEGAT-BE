import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { agentFilterQuerySchema } from '../agents/agent.schema.js';
import { toRepositoryFilters } from '../agents/agent.service.js';
import { listCategoriesResponseSchema } from './category.schema.js';

// Registration is synchronous; the async plugin signature is Fastify's contract,
// so the promise is returned explicitly rather than via `async`.
export const categoryRoutes: FastifyPluginAsyncZod = (app) => {
  const { categories } = app.services;

  app.get(
    '/categories',
    {
      schema: {
        operationId: 'listCategories',
        tags: ['categories'],
        summary: 'Marketplace categories with agent counts',
        description:
          'Every category in the KATTEGAT taxonomy, including empty ones, plus an "uncategorized" bucket when any agents fall outside it. ERC-8004 carries no category field — these are derived by KATTEGAT.\n\nAccepts the same filters as `GET /api/v1/agents`, and each count is the number of agents that category would return *under those filters*, so a count and the page it labels agree. `category`, `classified_only` and `min_confidence` are ignored here: they are what clicking a category sets, so applying them would report a number the click contradicts. Unfiltered, the counts describe the whole index and will not match a filtered grid.',
        /*
         * The shared filter vocabulary rather than a bespoke one. These counts label the agents
         * grid, so they have to be answerable under exactly the filters the grid is using; a
         * second definition of `trait` or `resolved_only` here is how the tabs drifted from the
         * page in the first place.
         */
        querystring: agentFilterQuerySchema,
        response: { 200: listCategoriesResponseSchema },
      },
    },
    async (request) => categories.list(toRepositoryFilters(request.query)),
  );

  return Promise.resolve();
};
