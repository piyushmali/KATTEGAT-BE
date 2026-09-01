import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Env } from '../config/env.js';
import type { AppInstance } from './app-instance.js';
import { createDatabase, type DatabaseHandle } from '../infrastructure/database/client.js';
import { createAiProvider } from '../integrations/ai/provider.js';
import { createChainReader } from '../integrations/erc8004/chain-reader.js';
import { createExplorerClient } from '../integrations/erc8004/explorer-client.js';
import { createAgentRepository } from '../modules/agents/agent.repository.js';
import { createAgentService, type AgentService } from '../modules/agents/agent.service.js';
import { agentRoutes } from '../modules/agents/agent.routes.js';
import { createCategoryRepository } from '../modules/categories/category.repository.js';
import { createCategoryService, type CategoryService } from '../modules/categories/category.service.js';
import { categoryRoutes } from '../modules/categories/category.routes.js';
import { createGasSponsor } from '../integrations/altana/gas-sponsor.js';
import { createKeystoreReader } from '../integrations/altana/keystore.js';
import { createNetworkReader, resolveNetwork } from '../integrations/altana/network.js';
import { createHiringRepository } from '../modules/hiring/hiring.repository.js';
import { hiringRoutes } from '../modules/hiring/hiring.routes.js';
import { createHiringService, type HiringService } from '../modules/hiring/hiring.service.js';
import { createErc8183JobReader } from '../integrations/erc8183/job-reader.js';
import { createJobRepository } from '../modules/jobs/job.repository.js';
import { jobRoutes } from '../modules/jobs/job.routes.js';
import { createJobService, type JobService } from '../modules/jobs/job.service.js';
import { createReputationRepository } from '../modules/reputation/reputation.repository.js';
import {
  createReputationService,
  type ReputationService,
} from '../modules/reputation/reputation.service.js';
import { reputationRoutes } from '../modules/reputation/reputation.routes.js';
import { createSearchService, type SearchService } from '../modules/search/search.service.js';
import { searchRoutes } from '../modules/search/search.routes.js';
import { createStatsService, type StatsService } from '../modules/stats/stats.service.js';
import { statsRoutes } from '../modules/stats/stats.routes.js';
import { healthRoutes } from './health.routes.js';
import { registerErrorHandler } from './error-handler.js';

const API_PREFIX = '/api/v1';
const APP_VERSION = '0.1.0';

/** The service registry every route plugin reads from. */
export interface AppServices {
  agents: AgentService;
  categories: CategoryService;
  hiring: HiringService;
  jobs: JobService;
  reputation: ReputationService;
  search: SearchService;
  stats: StatsService;
}

declare module 'fastify' {
  interface FastifyInstance {
    database: DatabaseHandle;
    services: AppServices;
    appVersion: string;
  }
}

export interface BuildServerOptions {
  env: Env;
  /** Shared with the domain services, which log through the same instance. */
  logger: Logger;
  /** Injectable so tests can supply a throwaway database. */
  database?: DatabaseHandle;
}

/**
 * Composes the Fastify application.
 *
 * Wiring happens here and only here — modules receive their dependencies as
 * arguments and never reach for a global. That is what makes the API testable
 * against a real database without starting a process.
 */
export async function buildServer({
  env,
  logger,
  database,
}: BuildServerOptions): Promise<AppInstance> {
  const app = Fastify({
    // Fastify's own request logging already emits the request id, method, url,
    // status and responseTime, so there is no custom logging hook here.
    loggerInstance: logger,
    // Trust an upstream proxy's X-Forwarded-* so rate limiting buckets by the
    // real client IP rather than the load balancer's.
    trustProxy: true,
    // Reuse an inbound request id when present so logs correlate across services.
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 200) return header;
      return randomUUID();
    },
    bodyLimit: 256 * 1024,
    /*
     * Fastify defaults this to 100 characters, which is shorter than the identifiers this API
     * routes on. An Altana session key is an uncompressed secp256k1 public key: `0x04` plus
     * 64 bytes hex, 130 characters. `DELETE /sessions/:public_key` answered 414 URI Too Long
     * before this, so revoking authority failed on a string-length default rather than on
     * anything about the request.
     *
     * 256 leaves room for a longer key format without inviting a URL as a payload; bodies are
     * still capped by `bodyLimit` above.
     */
    maxParamLength: 256,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('appVersion', APP_VERSION);
  app.decorate('database', database ?? createDatabase(env));

  /*
   * Composition root. Every dependency is constructed here and injected; no
   * module reaches for a global, which is what makes them testable in isolation
   * and keeps the dependency direction visible in one place.
   */
  const db = app.database.db;
  const agentRepository = createAgentRepository(db);
  const chainReader = createChainReader({ env, logger });
  const explorer = createExplorerClient(env, logger);

  /*
   * Which chain hiring runs on, resolved once from `ALTANA_NETWORK`. Nothing downstream
   * hardcodes a chain id, an explorer host or a token symbol, so going live is this value plus
   * the sponsor key rather than a code change.
   */
  const altanaNetwork = resolveNetwork(env.ALTANA_NETWORK);
  const altanaKeystore = createKeystoreReader(altanaNetwork, logger);

  /*
   * ERC-8183 on the session's chain, for hiring.
   *
   * A second reader rather than reusing the indexing one, because a hire lands on whatever chain
   * the user's session lives on and verification has to read that kernel. Sharing the indexer's
   * reader would verify jobs against the wrong chain whenever `ALTANA_NETWORK` is not the
   * registry's, which is exactly the case on testnet.
   *
   * Takes a client getter, not a client: the Altana network picks its RPC endpoint by probing, and
   * doing that at construction would put a round trip in the startup path.
   */
  const altanaReader = createNetworkReader(altanaNetwork, logger);
  const hiringEscrow = createErc8183JobReader({
    env,
    logger,
    client: () => altanaReader.client(),
    chainId: altanaNetwork.config.chainId,
    explorerUrl: altanaNetwork.config.explorer,
  });

  /*
   * ERC-8183 escrow, read from the same chain as the registry rather than from `ALTANA_NETWORK`.
   *
   * Deliberately not the session network. Jobs are linked to agents by provider address, and an
   * address only means one thing within one chain, so reading escrow from a chain other than the
   * one the catalogue was indexed from would produce links that are not real.
   */
  const jobRepository = createJobRepository(db);
  const jobReader = createErc8183JobReader({ env, logger });

  app.decorate('services', {
    agents: createAgentService(agentRepository, jobRepository),
    categories: createCategoryService(createCategoryRepository(db)),
    jobs: createJobService({
      repository: jobRepository,
      agents: agentRepository,
      reader: jobReader,
    }),
    reputation: createReputationService({
      repository: createReputationRepository(db),
      source: chainReader,
      explorer,
      logger,
    }),
    search: createSearchService({
      repository: agentRepository,
      jobs: jobRepository,
      ai: createAiProvider(env),
      logger,
    }),
    stats: createStatsService(db),
    hiring: createHiringService({
      repository: createHiringRepository(db),
      keystore: altanaKeystore,
      sponsor: createGasSponsor({
        network: altanaNetwork,
        keystore: altanaKeystore,
        privateKey: env.AGENT_GAS_SPONSOR_PRIVATE_KEY,
        amountWei: env.AGENT_GAS_SPONSOR_AMOUNT_WEI,
        maxBalanceWei: env.AGENT_GAS_SPONSOR_MAX_BALANCE_WEI,
        logger,
      }),
      network: altanaNetwork,
      escrow: hiringEscrow,
      jobs: jobRepository,
      logger,
    }),
  } satisfies AppServices);

  await app.register(helmet, {
    // The API serves JSON to a separate origin; CSP here would only constrain
    // the Swagger UI, which sets its own.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: env.NODE_ENV === 'production' ? 120 : 1_000,
    timeWindow: '1 minute',
    // Without this an unauthenticated public API is trivially exhaustible; the
    // upstream RPC and IPFS quotas it fronts are the real resource being protected.
    keyGenerator: (request) => request.ip,
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    // Lets a client quote the id from a failed call straight back to us.
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'KATTEGAT API',
        version: APP_VERSION,
        description:
          'Discovery, evaluation and trust layer for autonomous agents on BNB Smart Chain.\n\n' +
          'Agent identity, ownership and reputation are read from the ERC-8004 registries on ' +
          'BNB Smart Chain. Marketplace categories are derived by KATTEGAT — ERC-8004 itself ' +
          'carries no category field — and every classification ships the signals that produced it.',
      },
      servers: [{ url: `http://${env.HOST}:${String(env.PORT)}`, description: 'local' }],
      tags: [
        { name: 'agents', description: 'Agent discovery and detail' },
        { name: 'categories', description: 'Marketplace taxonomy' },
        { name: 'reputation', description: 'Live on-chain reputation reads' },
        { name: 'search', description: 'Natural-language agent search' },
        { name: 'system', description: 'Health and diagnostics' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandler(app);

  await app.register(healthRoutes);
  // One prefix, registered once per domain module.
  await app.register(agentRoutes, { prefix: API_PREFIX });
  await app.register(categoryRoutes, { prefix: API_PREFIX });
  await app.register(hiringRoutes, { prefix: API_PREFIX });
  await app.register(jobRoutes, { prefix: API_PREFIX });
  await app.register(reputationRoutes, { prefix: API_PREFIX });
  await app.register(searchRoutes, { prefix: API_PREFIX });
  await app.register(statsRoutes, { prefix: API_PREFIX });

  app.addHook('onClose', async () => {
    await app.database.close();
  });

  return app;
}
