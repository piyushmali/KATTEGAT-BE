import type { Logger } from 'pino';
import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.js';
import { erc8183Addresses } from '@altananetwork/sdk';
import { REGISTRY_CHAIN } from '../bsc-client.js';
import { createErc8183JobReader } from './job-reader.js';

/**
 * The kernel answers a read for a job it never minted, and the answer looks like a real job.
 *
 * Solidity returns the zero value for a missing entry, so `getJob(999999)` produces a
 * well-formed tuple whose status byte is 0, which is the same 0 that names the genuine status
 * OPEN. Nothing errors. Indexing without checking would write one identical "job 0 is open"
 * row per unminted id, and the first of them would sit on an agent's page as delivery history
 * for work nobody commissioned.
 *
 * These run against a stub client rather than the chain, because the case worth pinning is the
 * one the chain only produces by accident.
 */

const env = { BSC_RPC_URL: 'https://bsc-rpc.publicnode.com' } as Env;
const logger = { debug: () => undefined, warn: () => undefined } as unknown as Logger;

/** A zero-filled tuple, exactly as a read for an unminted id decodes. */
const absentJob = {
  id: 0n,
  client: '0x0000000000000000000000000000000000000000',
  provider: '0x0000000000000000000000000000000000000000',
  evaluator: '0x0000000000000000000000000000000000000000',
  description: '',
  budget: 0n,
  expiredAt: 0n,
  status: 0,
  hook: '0x0000000000000000000000000000000000000000',
  submittedAt: 0n,
  deliverable: `0x${'0'.repeat(64)}`,
};

const realJob = {
  ...absentJob,
  id: 41n,
  client: '0xAAaAaA0000000000000000000000000000000001',
  provider: '0xBBbBbB0000000000000000000000000000000002',
  evaluator: '0xCCcCcC0000000000000000000000000000000003',
  description: 'Report whether the position is still in range.',
  budget: 100_000_000_000_000_000n,
  expiredAt: 1_788_208_307n,
  status: 3,
  submittedAt: 1_788_100_000n,
  deliverable: `0x${'ab'.repeat(32)}`,
};

/** Answers `multicall` with whatever the test lines up, in order. */
function stubClient(results: unknown[]): PublicClient {
  return {
    multicall: ({ contracts }: { contracts: unknown[] }) =>
      Promise.resolve(contracts.map((_, i) => ({ status: 'success', result: results[i] }))),
  } as unknown as PublicClient;
}

/**
 * Answers `readContract` for policy resolution.
 *
 * `whitelisted` names the addresses this fake router accepts, so a test can reproduce a chain
 * where the SDK's pinned policy is rejected without needing that chain.
 */
function policyClient(whitelisted: string[], windowSeconds = 900): PublicClient {
  return {
    readContract: ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'policyWhitelist') {
        const candidate = String(args?.[0]).toLowerCase();
        return Promise.resolve(whitelisted.some((a) => a.toLowerCase() === candidate));
      }
      if (functionName === 'disputeWindow') return Promise.resolve(BigInt(windowSeconds));
      throw new Error(`unexpected read: ${functionName}`);
    },
  } as unknown as PublicClient;
}

/** The address the SDK pins for the chain this reader runs on. */
const SDK_POLICY = erc8183Addresses(REGISTRY_CHAIN.id).policy;
const OBSERVED_TESTNET_POLICY = '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA';

/**
 * A hire binds a verdict policy, and both halves of that can refuse.
 *
 * The router will not bind a policy it has not whitelisted, and the kernel will not fund a job
 * whose hook is the router until one is bound. So a stale policy address does not degrade a hire,
 * it stops it, and the failure surfaces as two opaque selectors rather than as a message.
 */
describe('escrowPolicy', () => {
  it('uses the SDK policy when the router accepts it', async () => {
    const reader = createErc8183JobReader({ env, logger, client: policyClient([SDK_POLICY], 604_800) });

    const policy = await reader.escrowPolicy();

    expect(policy.address).toBe(SDK_POLICY);
    expect(policy.usable).toBe(true);
    expect(policy.disputeWindowSeconds).toBe(604_800);
  });

  it('falls back to an observed policy when the pinned one is not whitelisted', async () => {
    /*
     * The measured state of BSC testnet: the router is a proxy that appears upgraded past the
     * address the SDK pins, so registerJob reverts and fund then reverts with PolicyNotSet.
     */
    const reader = createErc8183JobReader({
      env,
      logger,
      client: policyClient([OBSERVED_TESTNET_POLICY], 900),
    });

    const policy = await reader.escrowPolicy();

    expect(policy.address).toBe(OBSERVED_TESTNET_POLICY);
    expect(policy.usable).toBe(true);
    // The window comes from the policy in use, not the pinned one. 15 minutes, not 24 hours.
    expect(policy.disputeWindowSeconds).toBe(900);
  });

  it('reports hiring as unavailable rather than picking a policy that cannot be bound', async () => {
    const reader = createErc8183JobReader({ env, logger, client: policyClient([]) });

    const policy = await reader.escrowPolicy();

    /*
     * Reported, not thrown. Escrow history still reads fine without a usable policy, so this has
     * to degrade the hire path alone. Returning a policy marked usable would offer a button whose
     * transaction always reverts.
     */
    expect(policy.usable).toBe(false);
    expect(policy.disputeWindowSeconds).toBe(0);
  });

  it('resolves once and reuses the answer', async () => {
    let reads = 0;
    const counting = {
      readContract: ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        reads += 1;
        if (functionName === 'policyWhitelist') {
          return Promise.resolve(String(args?.[0]).toLowerCase() === SDK_POLICY.toLowerCase());
        }
        return Promise.resolve(900n);
      },
    } as unknown as PublicClient;

    const reader = createErc8183JobReader({ env, logger, client: counting });
    await reader.escrowPolicy();
    const after = reads;
    await reader.escrowPolicy();

    // A deployment constant, so re-reading it would put two calls on every page render.
    expect(reads).toBe(after);
  });
});

describe('readJobs', () => {
  it('drops a job whose returned id is not the one asked for', async () => {
    const reader = createErc8183JobReader({
      env,
      logger,
      client: stubClient([absentJob, absentJob]),
    });

    // Both ids read back as job 0, which is the shape an unminted id produces.
    await expect(reader.readJobs([90_001, 90_002])).resolves.toEqual([]);
  });

  it('keeps the real job and drops the phantom beside it', async () => {
    const reader = createErc8183JobReader({
      env,
      logger,
      client: stubClient([realJob, absentJob]),
    });

    const jobs = await reader.readJobs([41, 90_001]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobId).toBe(41);
  });

  it('normalises a job for storage without losing precision', async () => {
    const reader = createErc8183JobReader({ env, logger, client: stubClient([realJob]) });

    const [job] = await reader.readJobs([41]);

    // Lowercased so these can be joined against the registry, which stores them that way.
    expect(job?.providerAddress).toBe('0xbbbbbb0000000000000000000000000000000002');
    expect(job?.clientAddress).toBe('0xaaaaaa0000000000000000000000000000000001');
    // A decimal string, never a float: 18 decimals of $U does not survive a double.
    expect(job?.budgetRaw).toBe('100000000000000000');
    expect(job?.statusName).toBe('COMPLETED');
    expect(job?.submittedAt).toEqual(new Date(1_788_100_000_000));
  });

  it('reports an unsubmitted job as having no deliverable rather than 32 zero bytes', async () => {
    const open = { ...realJob, status: 1, submittedAt: 0n, deliverable: `0x${'0'.repeat(64)}` };
    const reader = createErc8183JobReader({ env, logger, client: stubClient([open]) });

    const [job] = await reader.readJobs([41]);

    expect(job?.deliverableHash).toBeNull();
    expect(job?.submittedAt).toBeNull();
  });
});
