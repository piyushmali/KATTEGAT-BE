import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ecosystemStatsResponseSchema } from './stats.schema.js';

// Registration is synchronous; the async plugin signature is Fastify's contract.
export const statsRoutes: FastifyPluginAsyncZod = (app) => {
  const { stats } = app.services;

  app.get(
    '/stats',
    {
      schema: {
        operationId: 'getEcosystemStats',
        tags: ['system'],
        summary: 'Marketplace-wide counts',
        description:
          'Real counts derived from indexed data, for the landing page. Contains no performance, volume or success-rate figures because ERC-8004 exposes none — `declared_active` is the agent\'s own claim from its registration file, not an observation of on-chain activity.',
        response: { 200: ecosystemStatsResponseSchema },
      },
    },
    async () => stats.ecosystem(),
  );

  return Promise.resolve();
};
