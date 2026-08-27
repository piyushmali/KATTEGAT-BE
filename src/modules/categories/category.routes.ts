import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
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
          'Every category in the KATTEGAT taxonomy, including empty ones, plus an "uncategorized" bucket when any agents fall outside it. ERC-8004 carries no category field — these are derived by KATTEGAT.',
        response: { 200: listCategoriesResponseSchema },
      },
    },
    async () => categories.list(),
  );

  return Promise.resolve();
};
