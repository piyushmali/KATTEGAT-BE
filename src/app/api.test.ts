import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { parseEnv } from '../config/env.js';
import { createDatabase, type DatabaseHandle } from '../infrastructure/database/client.js';
import {
  agentCategories,
  agentJobs,
  agentReputation,
  agents,
} from '../infrastructure/database/schema.js';
import { REGISTRY_CHAIN } from '../integrations/bsc-client.js';
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
const NEWEST = `${String(TEST_CHAIN)}:3`;
const OUT_OF_RANGE = `${String(TEST_CHAIN)}:4`;

/**
 * Carried by every fixture so a query can isolate them from real indexed data.
 *
 * These tests run against the same database the ingestion pipeline writes to, which holds
 * 317,476 live agents. Without a way to select only the fixtures, a `per_page=100` request
 * returns whatever happens to sort first, and the assertions become a statement about
 * production data.
 *
 * They previously passed by accident. The fixtures set `registered_at` while 317,010 real
 * rows leave it null, so the old `registered_at ... nulls last` ordering floated them to
 * the front of every list. Fixing that ordering is what exposed the coupling.
 */
const FIXTURE_TRAIT = 'test-fixture-only';
/**
 * Job ids for fixtures, far above the live counter (56,680 at the time of writing).
 *
 * Escrow evidence is scoped to the real chain, so these rows cannot use the fictional 31337 the
 * agents use. This keeps them from colliding with anything the indexer writes.
 */
const JOB_ID_BASE = 9_000_000;

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
      traitTags: ['x402-paid', 'declared-active', FIXTURE_TRAIT],
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
      traitTags: ['multichain', FIXTURE_TRAIT],
      capabilities: ['yield'],
      registeredAtBlock: 200,
      registeredAt: new Date('2026-02-01T00:00:00Z'),
      source: 'test',
      // Left unresolved on purpose: the API must still return this agent.
      metadataResolvedAt: null,
    },
    {
      /*
       * The newest agent, and the one with no timestamp.
       *
       * This shape is 317,010 of 317,476 rows in production: found by the ID-walk
       * backfill, which does not read the `Registered` event, so the block timestamp is
       * unknown. Ordering by `registered_at ... nulls last` sent every one of them behind
       * the handful that do have a date, and "Recently registered" opened on an agent
       * 7,458 registrations old.
       */
      id: NEWEST,
      chainId: TEST_CHAIN,
      agentId: 3,
      ownerAddress: '0x4444444444444444444444444444444444444444',
      agentUri: 'ipfs://test-newest',
      // Blank, not null. `?? fallback` does not catch this, and 321 production rows have it.
      name: '',
      description: '   ',
      protocolTag: 'unconfigured',
      traitTags: [FIXTURE_TRAIT],
      capabilities: [],
      registeredAtBlock: null,
      registeredAt: null,
      source: 'test',
      metadataResolvedAt: new Date('2026-03-01T00:00:00Z'),
    },
    {
      // Carries a summary that is not a score. See the reputation row below.
      id: OUT_OF_RANGE,
      chainId: TEST_CHAIN,
      agentId: 4,
      ownerAddress: '0x5555555555555555555555555555555555555555',
      agentUri: 'ipfs://test-out-of-range',
      name: 'Latency Reporter',
      description: 'Clients record a response time here rather than a rating.',
      protocolTag: 'a2a',
      traitTags: [FIXTURE_TRAIT],
      capabilities: [],
      registeredAtBlock: null,
      registeredAt: null,
      source: 'test',
      metadataResolvedAt: new Date('2026-03-02T00:00:00Z'),
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
  await handle.db.insert(agentReputation).values([
    {
      agentId: REBALANCER,
      feedbackCount: 3,
      clientCount: 2,
      summaryValue: 425,
      summaryDecimals: 2,
      source: 'test',
    },
    {
      /*
       * 14133 at 2 decimals decodes to 141.33, which is outside the 0-to-100 range ERC-8004
       * defines for a score. Taken from a real indexed agent: exactly one of the 4,358 rows
       * carrying a summary is out of range, and it was being served as a rating.
       */
      agentId: OUT_OF_RANGE,
      feedbackCount: 3,
      clientCount: 1,
      summaryValue: 14_133,
      summaryDecimals: 2,
      source: 'test',
    },
  ]);

  /*
   * ERC-8183 jobs for the rebalancer, one per status that matters.
   *
   * The budgets are deliberately lopsided. The OPEN job carries 5 U while the three funded ones
   * carry 1, 2 and 3, so a bug that counts an unfunded job as escrowed reports 11 U instead of
   * 6 rather than something plausible. That distinction is the whole point: `createJob` and
   * `setBudget` cost nothing, and only `fund` moves tokens, so an OPEN budget is a figure
   * someone typed rather than money at stake.
   *
   * Unlike the agents above, these carry the real chain id rather than 31337. They have to:
   * an agent's escrow record counts only the chain the catalogue was indexed from, so jobs on a
   * fictional chain would be filtered out and every assertion below would pass against zero.
   *
   * Collision with real data is avoided by job id instead. `JOB_ID_BASE` sits far above the live
   * counter, and these rows are removed by agent rather than by chain so the cleanup cannot
   * reach anything the indexer wrote.
   */
  await handle.db.insert(agentJobs).values([
    {
      id: `${String(REGISTRY_CHAIN.id)}:${String(JOB_ID_BASE + 901)}`,
      chainId: REGISTRY_CHAIN.id,
      jobId: JOB_ID_BASE + 901,
      clientAddress: '0x6666666666666666666666666666666666666666',
      providerAddress: '0x2222222222222222222222222222222222222222',
      evaluatorAddress: '0x7777777777777777777777777777777777777777',
      budgetRaw: '5000000000000000000',
      status: 0,
      description: 'Created and never funded.',
      expiredAt: new Date('2026-04-01T00:00:00Z'),
      agentId: REBALANCER,
    },
    {
      id: `${String(REGISTRY_CHAIN.id)}:${String(JOB_ID_BASE + 902)}`,
      chainId: REGISTRY_CHAIN.id,
      jobId: JOB_ID_BASE + 902,
      clientAddress: '0x6666666666666666666666666666666666666666',
      providerAddress: '0x2222222222222222222222222222222222222222',
      evaluatorAddress: '0x7777777777777777777777777777777777777777',
      budgetRaw: '1000000000000000000',
      status: 1,
      description: 'Funded, not yet delivered.',
      expiredAt: new Date('2026-04-02T00:00:00Z'),
      agentId: REBALANCER,
    },
    {
      id: `${String(REGISTRY_CHAIN.id)}:${String(JOB_ID_BASE + 903)}`,
      chainId: REGISTRY_CHAIN.id,
      jobId: JOB_ID_BASE + 903,
      clientAddress: '0x6666666666666666666666666666666666666666',
      providerAddress: '0x2222222222222222222222222222222222222222',
      evaluatorAddress: '0x7777777777777777777777777777777777777777',
      budgetRaw: '2000000000000000000',
      status: 2,
      description: 'Delivered, inside the dispute window.',
      expiredAt: new Date('2026-04-03T00:00:00Z'),
      submittedAt: new Date('2026-03-30T00:00:00Z'),
      deliverableHash: `0x${'ab'.repeat(32)}`,
      agentId: REBALANCER,
    },
    {
      id: `${String(REGISTRY_CHAIN.id)}:${String(JOB_ID_BASE + 904)}`,
      chainId: REGISTRY_CHAIN.id,
      jobId: JOB_ID_BASE + 904,
      clientAddress: '0x6666666666666666666666666666666666666666',
      providerAddress: '0x2222222222222222222222222222222222222222',
      evaluatorAddress: '0x7777777777777777777777777777777777777777',
      budgetRaw: '3000000000000000000',
      status: 3,
      description: 'Delivered and released.',
      expiredAt: new Date('2026-04-04T00:00:00Z'),
      submittedAt: new Date('2026-03-25T00:00:00Z'),
      deliverableHash: `0x${'cd'.repeat(32)}`,
      agentId: REBALANCER,
    },
  ]);

  app = await buildServer({ env, logger: pino({ level: 'silent' }), database: handle });
  await app.ready();
});

afterAll(async () => {
  if (!reachable) return;
  /*
   * Jobs go first, and by agent rather than by cascade or by chain.
   *
   * Not by cascade, because the agent foreign key is `on delete set null`: a job is real whether
   * or not we can attribute it, so deleting the agents would strand these rows unattributed
   * instead of removing them.
   *
   * Not by chain, because these fixtures carry the real chain id, so a chain-wide delete would
   * take 56,680 indexed jobs with them.
   */
  await handle.db.delete(agentJobs).where(eq(agentJobs.agentId, REBALANCER));
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

  /**
   * Pins `meta.total` to an exact number, which the envelope test above cannot do because it
   * counts the whole table alongside 325,546 real rows.
   *
   * Guards the count query specifically. It does not join `agent_reputation`, deliberately, so
   * that the planner can answer the discovery grid's default filter from a partial index instead
   * of sequentially scanning every row — a 47x difference in I/O and several seconds through the
   * API. That join was safe to drop only because the relationship is one-to-one and no filter
   * references the table, and both of those are assumptions about the schema rather than about
   * this function.
   *
   * So this asserts the arithmetic the optimisation depends on. If a second reputation row per
   * agent ever becomes possible, or a filter starts referencing that table, the count breaks
   * here rather than quietly reporting inflated totals in production.
   */
  it('counts each matching agent exactly once', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      // per_page=1 so the page and the count disagree unless the count is computed independently.
      url: `/api/v1/agents?trait=${FIXTURE_TRAIT}&per_page=1`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: unknown[]; meta: { total: number } }>();

    // Four fixtures carry the trait, each with exactly one reputation row.
    expect(body.meta.total).toBe(4);
    expect(body.data.length).toBe(1);
  });

  it('filters by derived category', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?category=rebalancing&trait=${FIXTURE_TRAIT}&per_page=100`,
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
      url: `/api/v1/agents?protocol=mcp&trait=${FIXTURE_TRAIT}&per_page=100`,
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
      url: `/api/v1/agents?trait=x402-paid&trait=declared-active&trait=${FIXTURE_TRAIT}&per_page=100`,
    });
    const impossible = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?trait=x402-paid&trait=multichain&trait=${FIXTURE_TRAIT}&per_page=100`,
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
      url: `/api/v1/agents?q=highest%20APY&trait=${FIXTURE_TRAIT}&per_page=100`,
    });

    const ids = response
      .json<{ data: { identity: { id: string } }[] }>()
      .data.map((agent) => agent.identity.id);
    expect(ids).toContain(YIELD_AGENT);
  });

  it('still returns agents whose metadata never resolved, and can exclude them', async () => {
    guard();
    const all = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?protocol=mcp&trait=${FIXTURE_TRAIT}&per_page=100`,
    });
    const resolvedOnly = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?protocol=mcp&resolved_only=true&trait=${FIXTURE_TRAIT}&per_page=100`,
    });

    const idsOf = (r: typeof all): string[] =>
      r.json<{ data: { identity: { id: string } }[] }>().data.map((a) => a.identity.id);

    expect(idsOf(all)).toContain(YIELD_AGENT);
    expect(idsOf(resolvedOnly)).not.toContain(YIELD_AGENT);
  });

  it('ranks by agent id, so a missing timestamp cannot outrank a newer agent', async () => {
    /*
     * The bug this pins. Agent 3 is the newest and has no `registered_at`; agents 1 and 2
     * are older and do. Ordering by `registered_at ... nulls last` put agent 3 last, which
     * in production meant 7,458 genuinely newer agents sorted behind one stale replay
     * window on both the discovery grid and the landing page.
     *
     * Ids are minted sequentially, so id order *is* registration order, for every row and
     * with no nulls.
     */
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?sort=registered_at&direction=desc&trait=${FIXTURE_TRAIT}&per_page=100`,
    });

    const ids = response
      .json<{ data: { identity: { id: string } }[] }>()
      .data.map((agent) => agent.identity.id);

    expect(ids).toEqual([OUT_OF_RANGE, NEWEST, YIELD_AGENT, REBALANCER]);
  });

  it('refuses to report an out-of-range summary as a score', async () => {
    /*
     * A live agent came back at 141.33 on a 0-to-100 scale, because this path divided the
     * fixed-point pair inline instead of going through `decodeScore` and so skipped the
     * range check. It was the third place in the codebase computing a score and the only one
     * that got it wrong.
     *
     * `getSummary` averages whatever clients posted and the registry does not require it to
     * be a rating, so a value outside the range is not a low score, it is not a score.
     * `summary_value` and `summary_decimals` still carry what was recorded.
     */
    guard();
    const response = await app.inject({ method: 'GET', url: `/api/v1/agents/${OUT_OF_RANGE}` });

    const { reputation } = response.json<{
      data: {
        reputation: { score: number | null; summary_value: number; feedback_count: number };
      };
    }>().data;

    expect(reputation.score).toBeNull();
    // The recorded value survives, so the UI can show it as recorded rather than as a rating.
    expect(reputation.summary_value).toBe(14_133);
    expect(reputation.feedback_count).toBe(3);
  });

  it('never serves a blank name or description', async () => {
    /*
     * Agent 3 stores `name: ''` and `description: '   '`, which is 529 rows in production.
     * A blank name rendered an empty heading, because `?? fallback` does not catch it.
     */
    guard();
    const response = await app.inject({ method: 'GET', url: `/api/v1/agents/${NEWEST}` });

    const { profile } = response.json<{
      data: { profile: { name: string; description: string | null } };
    }>().data;

    expect(profile.name).toBe('Agent #3');
    // Null, not an empty string, so the UI's "no description" state is reachable.
    expect(profile.description).toBeNull();
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

interface JobsSummary {
  total: number;
  funded: number;
  completed: number;
  awaiting_release: number;
  settled_raw: string;
  escrowed_raw: string;
}

/**
 * ERC-8183 escrow is the strongest claim this marketplace makes about an agent, so the tests
 * here are about what it must refuse to say rather than what it displays.
 */
describe('ERC-8183 job evidence', () => {
  it('counts a job as funded only once escrow was actually funded', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${REBALANCER}/jobs`,
    });

    expect(response.statusCode).toBe(200);
    const summary = response.json<{ meta: { summary: JobsSummary } }>().meta.summary;

    // Four jobs name this agent, three of them cost someone something.
    expect(summary.total).toBe(4);
    expect(summary.funded).toBe(3);
    expect(summary.completed).toBe(1);
    expect(summary.awaiting_release).toBe(1);
  });

  it('leaves an unfunded budget out of the escrowed total', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${REBALANCER}/jobs`,
    });

    const summary = response.json<{ meta: { summary: JobsSummary } }>().meta.summary;

    /*
     * The regression this exists for. 1 + 2 + 3 U were funded; a fourth job sets a 5 U budget
     * and never funded it. Summing every budget would report 11 U at stake, which is the sum of
     * four true numbers and a false statement.
     */
    expect(summary.escrowed_raw).toBe('6000000000000000000');
    // Released, which is only the completed job.
    expect(summary.settled_raw).toBe('3000000000000000000');
  });

  it('carries the dispute window so unsettled escrow reads as expected rather than stuck', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${REBALANCER}/jobs`,
    });

    const meta = response.json<{ meta: { dispute_window_seconds: number; token_decimals: number } }>().meta;

    expect(meta.dispute_window_seconds).toBeGreaterThan(0);
    expect(meta.token_decimals).toBe(18);
  });

  it('reports no jobs as null rather than a row of zeroes', async () => {
    guard();
    const response = await app.inject({ method: 'GET', url: `/api/v1/agents/${YIELD_AGENT}` });

    /*
     * Zeroes would read as "hired and delivered nothing", which is a far worse thing to say
     * about an agent than "not yet hired through this rail". They are different claims and the
     * absence of the object is what keeps them apart.
     */
    expect(response.json<{ data: { jobs: unknown } }>().data.jobs).toBeNull();
  });

  it('attaches the tally to agents in a list, not just on their own page', async () => {
    guard();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?trait=${FIXTURE_TRAIT}&per_page=100`,
    });

    const body = response.json<{ data: { identity: { id: string }; jobs: JobsSummary | null }[] }>();
    const rebalancer = body.data.find((agent) => agent.identity.id === REBALANCER);

    expect(rebalancer?.jobs?.funded).toBe(3);
  });
});

describe('CORS preflight', () => {
  it('allows the methods the API actually exposes, including DELETE', async () => {
    guard();

    /*
     * The regression this exists for. `methods` listed only GET, POST and OPTIONS while
     * revocation is a DELETE, so a browser's preflight omitted it and confirming a revocation
     * failed from the site while every curl test passed — curl sends no preflight.
     *
     * Worth a test because of which endpoint it was. Confirming a revocation is the call that
     * tells a user their agent's authority has ended, so a transport-level block there is the
     * worst place in this API for a failure nobody sees.
     */
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/sessions/0x04aa',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'DELETE',
      },
    });

    const allowed = String(response.headers['access-control-allow-methods'] ?? '');
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(allowed).toContain(method);
    }
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
