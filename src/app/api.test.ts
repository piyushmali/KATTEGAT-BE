import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { parseEnv } from '../config/env.js';
import { createDatabase, type DatabaseHandle } from '../infrastructure/database/client.js';
import { agentCategories, agentReputation, agents } from '../infrastructure/database/schema.js';
import { buildServer } from './server.js';
import type { AppInstance } from './app-instance.js';

/**
 * API contract tests, exercised through `app.inject()` against a real Postgres.
 *
 * No HTTP listener and no mocked repository: the things most likely to break are
 * the SQL and the response contract, and a mocked database would test neither.
 *
 * Fixtures use chain id 31337 (the Hardhat convention) so they cannot collide
 * with real BSC data (chain 56) in a developer's local database, and are removed
 * afterwards regardless of outcome.
 */

const TEST_CHAIN = 31337;
const REBALANCER = `${String(TEST_CHAIN)}:1`;
const YIELD_AGENT = `${String(TEST_CHAIN)}:2`;

const databaseUrl = process.env.DATABASE_URL;

let handle: DatabaseHandle;
let app: AppInstance;
let reachable = false;

beforeAll(async () => {
  if (!databaseUrl) return;

  const env = parseEnv({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test' });
  handle = createDatabase(env);
  reachable = await handle.ping();
  if (!reachable) {
    await handle.close();
    return;
  }

  await handle.db.insert(agents).values([
    {
      id: REBALANCER,
      chainId: TEST_CHAIN,
      agentId: 1,
      ownerAddress: '0x1111111111111111111111111111111111111111',
      walletAddress: '0x2222222222222222222222222222222222222222',
      agentUri: 'ipfs://test-rebalancer',
      name: 'Test Rebalancer',
      description: 'Keeps a portfolio at its target allocation.',
      protocolTag: 'a2a',
      traitTags: ['x402-paid', 'declared-active'],
      capabilities: ['rebalance'],
      registeredAtBlock: 100,
      registeredAt: new Date('2026-01-01T00:00:00Z'),
      source: 'test',
      metadataResolvedAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: YIELD_AGENT,
      chainId: TEST_CHAIN,
      agentId: 2,
      ownerAddress: '0x3333333333333333333333333333333333333333',
      agentUri: null,
      name: 'Test Yield Router',
      description: 'Chases the highest APY.',
      protocolTag: 'mcp',
      traitTags: ['multichain'],
      capabilities: ['yield'],
      registeredAtBlock: 200,
      registeredAt: new Date('2026-02-01T00:00:00Z'),
      source: 'test',
      // Left unresolved on purpose: the API must still return this agent.
      metadataResolvedAt: null,
    },
  ]);

  await handle.db.insert(agentCategories).values([
    {
      agentId: REBALANCER,
      category: 'rebalancing',
      confidence: 0.8,
      isPrimary: true,
      signals: ['capability:rebalance'],
      classifierVersion: 'rules-v2',
    },
    {
      agentId: YIELD_AGENT,
      category: 'yield-optimization',
      confidence: 0.6,
      isPrimary: true,
      signals: ['keyword:apy'],
      classifierVersion: 'rules-v2',
    },
  ]);

  // 425 at 2 decimals == 4.25. Chosen so a bug that ignores the decimals would
  // surface as 425 instead of quietly rounding to something plausible.
  await handle.db.insert(agentReputation).values({
    agentId: REBALANCER,
    feedbackCount: 3,
    clientCount: 2,
    summaryValue: 425,
    summaryDecimals: 2,
    source: 'test',
  });

  app = await buildServer({ env, logger: pino({ level: 'silent' }), database: handle });
  await app.ready();
});

afterAll(async () => {
  if (!reachable) return;
  // Cascades remove the category and reputation rows.
  await handle.db.delete(agents).where(eq(agents.chainId, TEST_CHAIN));
  await app.close();
});

const guard = (): void => {
  if (!reachable) {
    throw new Error(
      'DATABASE_URL is not reachable. Start Postgres and run `pnpm db:migrate` before `pnpm test`.',
    );
  }
};

describe('GET /health', () => {
  it('reports database and ingestion status', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; checks: { database: string } }>();
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('up');
  });
});

describe('GET /api/v1/agents', () => {
  it('returns a paginated envelope', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents?per_page=5' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: unknown[]; meta: { per_page: number; total: number } }>();
    expect(body.meta.per_page).toBe(5);
    expect(body.data.length).toBeLessThanOrEqual(5);
    expect(body.meta.total).toBeGreaterThanOrEqual(2);
  });

  it('filters by derived category', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?category=rebalancing&per_page=100',
    });

    const body = response.json<{ data: { identity: { id: string } }[] }>();
    const ids = body.data.map((agent) => agent.identity.id);
    expect(ids).toContain(REBALANCER);
    expect(ids).not.toContain(YIELD_AGENT);
  });

  it('filters by protocol tag', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?protocol=mcp&per_page=100',
    });

    const ids = response
      .json<{ data: { identity: { id: string } }[] }>()
      .data.map((agent) => agent.identity.id);
    expect(ids).toContain(YIELD_AGENT);
    expect(ids).not.toContain(REBALANCER);
  });

  it('filters by trait with AND semantics', async () => {
    guard();
    const both = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?trait=x402-paid&trait=declared-active&per_page=100',
    });
    const impossible = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?trait=x402-paid&trait=multichain&per_page=100',
    });

    const idsOf = (r: typeof both): string[] =>
      r.json<{ data: { identity: { id: string } }[] }>().data.map((a) => a.identity.id);

    expect(idsOf(both)).toContain(REBALANCER);
    // No fixture carries both traits, so requiring both must exclude everything.
    expect(idsOf(impossible)).not.toContain(REBALANCER);
  });

  it('searches name and description', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?q=highest%20APY&per_page=100',
    });

    const ids = response
      .json<{ data: { identity: { id: string } }[] }>()
      .data.map((agent) => agent.identity.id);
    expect(ids).toContain(YIELD_AGENT);
  });

  it('still returns agents whose metadata never resolved, and can exclude them', async () => {
    guard();
    const all = await app.inject({ method: 'GET', url: '/api/v1/agents?protocol=mcp&per_page=100' });
    const resolvedOnly = await app.inject({
      method: 'GET',
      url: '/api/v1/agents?protocol=mcp&resolved_only=true&per_page=100',
    });

    const idsOf = (r: typeof all): string[] =>
      r.json<{ data: { identity: { id: string } }[] }>().data.map((a) => a.identity.id);

    expect(idsOf(all)).toContain(YIELD_AGENT);
    expect(idsOf(resolvedOnly)).not.toContain(YIELD_AGENT);
  });

  it('rejects an oversized page with a field-level error', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents?per_page=1000' });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; request_id: string } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.request_id).toBeTruthy();
  });
});

describe('GET /api/v1/agents/:id', () => {
  it('returns the agent with its classification signals', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: `/api/v1/agents/${REBALANCER}` });

    expect(response.statusCode).toBe(200);
    const { data } = response.json<{
      data: {
        profile: { name: string };
        categories: { category: string; signals: string[]; is_primary: boolean }[];
      };
    }>();

    expect(data.profile.name).toBe('Test Rebalancer');
    expect(data.categories[0]?.category).toBe('rebalancing');
    expect(data.categories[0]?.signals).toContain('capability:rebalance');
  });

  it('decodes the registry fixed-point reputation rather than echoing the raw integer', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: `/api/v1/agents/${REBALANCER}` });

    const { data } = response.json<{
      data: {
        reputation: {
          score: number;
          summary_value: number;
          summary_decimals: number;
          feedback_count: number;
        };
      };
    }>();

    expect(data.reputation.summary_value).toBe(425);
    expect(data.reputation.summary_decimals).toBe(2);
    // The whole point: 425 at 2dp is 4.25, not 425.
    expect(data.reputation.score).toBeCloseTo(4.25, 6);
    expect(data.reputation.feedback_count).toBe(3);
  });

  it('distinguishes "no reputation yet" from a zero score', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: `/api/v1/agents/${YIELD_AGENT}` });

    const { data } = response.json<{ data: { reputation: unknown } }>();
    expect(data.reputation).toBeNull();
  });

  it('returns a structured 404 for an unknown agent', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${String(TEST_CHAIN)}:999999`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('rejects a malformed id', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/nonsense' });
    expect(response.statusCode).toBe(422);
  });
});

describe('GET /api/v1/categories', () => {
  it('lists every taxonomy category, including empty ones', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: '/api/v1/categories' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { id: string; agent_count: number }[] }>();
    const ids = body.data.map((category) => category.id);

    // All four launch categories are peers and must always be browsable.
    expect(ids).toContain('rebalancing');
    expect(ids).toContain('grid-trading');
    expect(ids).toContain('yield-optimization');
    expect(ids).toContain('health-factor-monitoring');
  });
});

describe('error envelope', () => {
  it('uses one shape for unknown routes and echoes a request id header', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBeTruthy();
    const body = response.json<{ error: { code: string; message: string; request_id: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.request_id).toBeTruthy();
  });
});
