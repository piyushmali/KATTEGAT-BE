import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { GasSponsor } from '../../integrations/altana/gas-sponsor.js';
import type { KeystoreReader } from '../../integrations/altana/keystore.js';
import { resolveNetwork } from '../../integrations/altana/network.js';
import type { Erc8183JobReader, JobRead } from '../../integrations/erc8183/job-reader.js';
import type { JobRepository } from '../jobs/job.repository.js';
import type { HiringRepository } from './hiring.repository.js';
import { createHiringService } from './hiring.service.js';

/**
 * Recording a hire is the one write in this module that describes money, so what it refuses
 * matters more than what it accepts.
 *
 * Every case below is a request that would otherwise put a false statement on an agent's page:
 * a job that does not exist, a real job belonging to someone else, or a job whose escrow was
 * never funded. None of them are hypothetical shapes — the first two are what an unminted id and
 * a mistyped agent produce, and the third costs an attacker nothing to manufacture.
 */

const AGENT = '56:269223';
const AGENT_WALLET = '0x72070faa1e33d7f8b31397bc8da65be2b1f6281f';
const OTHER_WALLET = '0x1614f31e3dc2fc334c4c9742de233265591f7674';

const job = (over: Partial<JobRead> = {}): JobRead => ({
  chainId: 97,
  jobId: 857,
  clientAddress: '0xb69385da73e15aab012ffa0407b3b63af67af3c1',
  providerAddress: AGENT_WALLET,
  evaluatorAddress: '0xd7d36d66d2f1b608a0f943f722d27e3744f66f25',
  budgetRaw: '0',
  status: 1,
  statusName: 'FUNDED',
  description: 'Report whether the position is still in range.',
  expiredAt: new Date('2026-09-01T08:33:43.000Z'),
  submittedAt: null,
  deliverableHash: null,
  ...over,
});

function service({
  jobs = [job()],
  walletAddress = AGENT_WALLET,
  agentFound = true,
}: { jobs?: JobRead[]; walletAddress?: string | null; agentFound?: boolean } = {}) {
  const saved: JobRead[] = [];

  const escrow = {
    chainId: 97,
    addresses: {
      commerce: '0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE',
      router: '0xD7d36D66d2F1B608A0F943f722D27e3744f66F25',
      policy: '0x4F4678D4439feC812Ac7674Bb3Efb4C8f5Fb78A6',
      registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      paymentToken: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565',
    },
    explorerUrl: 'https://testnet.bscscan.com',
    jobCounter: () => Promise.resolve(857),
    escrowPolicy: () =>
      Promise.resolve({
        address: '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA' as const,
        disputeWindowSeconds: 900,
        usable: true,
      }),
    readJobs: () => Promise.resolve(jobs),
  } as unknown as Erc8183JobReader;

  const instance = createHiringService({
    repository: {
      findAgent: () => Promise.resolve(agentFound ? { walletAddress } : null),
    } as unknown as HiringRepository,
    keystore: {} as KeystoreReader,
    sponsor: { enabled: false, address: null } as unknown as GasSponsor,
    network: resolveNetwork('bnb-testnet'),
    escrow,
    jobs: {
      save: (rows: readonly JobRead[]) => {
        saved.push(...rows);
        return Promise.resolve(rows.length);
      },
      reattribute: () => Promise.resolve(0),
    } satisfies Pick<JobRepository, 'save' | 'reattribute'>,
    logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
  });

  return { instance, saved };
}

describe('recordJob', () => {
  it('records a funded job that names this agent', async () => {
    const { instance, saved } = service();

    const result = await instance.recordJob(AGENT, { job_id: 857 });

    expect(result.data.job_id).toBe(857);
    expect(result.data.status).toBe('FUNDED');
    expect(saved).toHaveLength(1);
  });

  it('refuses a job the kernel does not have', async () => {
    /*
     * `readJobs` returns nothing for an id the kernel never minted, because reading one gives a
     * zero-filled tuple rather than an error and the reader drops those. Without this branch the
     * absence would surface as a crash instead of a message.
     */
    const { instance, saved } = service({ jobs: [] });

    await expect(instance.recordJob(AGENT, { job_id: 99_999_999 })).rejects.toThrow(
      /does not exist on chain/i,
    );
    expect(saved).toHaveLength(0);
  });

  it('refuses a real job that names a different provider', async () => {
    /*
     * The check that stops one agent's work being claimed by another. The kernel names providers
     * by address, so nothing about job 857 says which catalogue entry it belongs to except this
     * comparison.
     */
    const { instance, saved } = service({ jobs: [job({ providerAddress: OTHER_WALLET })] });

    await expect(instance.recordJob(AGENT, { job_id: 857 })).rejects.toThrow(
      /names .* as its provider, which is not this agent/i,
    );
    expect(saved).toHaveLength(0);
  });

  it('refuses a job whose escrow was never funded', async () => {
    /*
     * OPEN costs nothing to create and needs no agreement from the agent, so accepting one would
     * let anyone pad an agent's history for free.
     */
    const { instance, saved } = service({ jobs: [job({ status: 0, statusName: 'OPEN' })] });

    await expect(instance.recordJob(AGENT, { job_id: 857 })).rejects.toThrow(/not been funded/i);
    expect(saved).toHaveLength(0);
  });

  it('refuses when the agent publishes no wallet to compare against', async () => {
    // Without an address there is no way to tie the job to the agent, so nothing is assumed.
    const { instance, saved } = service({ walletAddress: null });

    await expect(instance.recordJob(AGENT, { job_id: 857 })).rejects.toThrow(/no wallet address/i);
    expect(saved).toHaveLength(0);
  });

  it('reports a hire on the session chain as not counting toward the agent record', async () => {
    /*
     * Testnet. The job is real and verified, but the agent is not registered on that kernel, so
     * presenting it as delivery history would be manufacturing one. In production the session
     * chain is the registry chain and this flips to true.
     */
    const { instance } = service();

    const result = await instance.recordJob(AGENT, { job_id: 857 });

    expect(result.data.chain_id).toBe(97);
    expect(result.data.counts_as_evidence).toBe(false);
  });

  it('carries the whitelisted policy and the three call targets a hire needs', async () => {
    const { instance } = service();

    const result = await instance.recordJob(AGENT, { job_id: 857 });

    // Not the SDK's pinned policy, which this router does not whitelist.
    expect(result.meta.escrow.policy_address).toBe('0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA');
    expect(result.meta.escrow.allowed_targets).toHaveLength(3);
    expect(result.meta.escrow.dispute_window_seconds).toBe(900);
  });
});
