import type { Logger } from 'pino';
import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.js';
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
const logger = { debug: () => undefined } as unknown as Logger;

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
