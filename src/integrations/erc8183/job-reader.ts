import {
  erc8183Addresses,
  JOB_STATUS,
  type Erc8183Addresses,
  type JobStatusName,
} from '@altananetwork/sdk';
import type { Logger } from 'pino';
import type { Address, PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { upstreamUnavailable } from '../../shared/errors.js';
import { createBscClient, REGISTRY_CHAIN } from '../bsc-client.js';
import { commerceAbi, policyAbi, routerAbi } from './abi.js';

/**
 * Reading ERC-8183 jobs: the escrowed work agents were actually paid for.
 *
 * The evidence half of this marketplace. Reputation says what clients claimed about an agent;
 * a job says a budget was locked on chain, delivered against, and released. Neither is ours to
 * author, and this reads the second one.
 *
 * Read-only by construction, and that is the point rather than a limitation. Indexing job
 * history needs no key, no permission and no relationship with Altana or the kernel: the
 * escrow is a public contract, so the same numbers are checkable by anyone who doubts them.
 * The write path lives in the hiring module and goes through the user's own wallet.
 *
 * Jobs are read from the same chain as the registry (see `bsc-client.ts`). Not a detail: the
 * kernel names a provider address, agents are matched to jobs by address, and an address only
 * means one thing within one chain.
 */

/**
 * The kernel's status indices, named once.
 *
 * Derived from the SDK's own array rather than written out, so the numbers cannot drift from
 * the enum they encode.
 *
 * The distinction that matters for anything we display is OPEN against everything after it.
 * `createJob` and `setBudget` only record an intention; `fund` is what moves tokens into
 * escrow. So an OPEN job can carry a large budget and have escrowed nothing, and measured on
 * mainnet that is the normal case rather than an edge one: 27 of 40 OPEN jobs attributed to
 * agents had a zero budget, and the OPEN bucket held the single largest budget total of any
 * status. Counting those as value at stake would overstate this marketplace by an order of
 * magnitude, using numbers that are individually true.
 */
export const JOB_STATUS_INDEX = {
  open: JOB_STATUS.indexOf('OPEN'),
  funded: JOB_STATUS.indexOf('FUNDED'),
  submitted: JOB_STATUS.indexOf('SUBMITTED'),
  completed: JOB_STATUS.indexOf('COMPLETED'),
  rejected: JOB_STATUS.indexOf('REJECTED'),
  expired: JOB_STATUS.indexOf('EXPIRED'),
} as const;

/** Terminal statuses never change again: COMPLETED, REJECTED, EXPIRED. */
export const FIRST_TERMINAL_STATUS = JOB_STATUS_INDEX.completed;

/**
 * The token the kernel escrows: United Stables, $U.
 *
 * Fixed per deployment rather than per job — `ERC8183_ADDRESSES` names one `paymentToken` for
 * each chain — so these are constants rather than a read on the request path. Both values were
 * read off the live contracts, mainnet and testnet, and agree.
 *
 * Sent to clients rather than assumed by them, so no UI hardcodes a symbol or divides by the
 * wrong power of ten.
 */
export const PAYMENT_TOKEN = { symbol: 'U', decimals: 18 } as const;

/**
 * Jobs per `getJob` multicall.
 *
 * Lower than the registry's chunk sizes on purpose. A job carries its description inline, up
 * to 4096 bytes by kernel rule, so a chunk of this size can return around 400KB where an
 * equivalent chunk of agent ids returns a few hundred bytes.
 */
const JOB_MULTICALL_CHUNK = 100;

/** Chunks in flight at once. The walk is latency-bound, same as the registry's. */
const JOB_MULTICALL_CONCURRENCY = 6;

/** A job as the kernel holds it, normalised for storage. */
export interface JobRead {
  chainId: number;
  jobId: number;
  /** Lowercased, matching how the registry stores addresses so the two can be joined. */
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  /** Raw $U units (18 decimals) as a decimal string, never a float. */
  budgetRaw: string;
  status: number;
  statusName: JobStatusName | 'UNKNOWN';
  description: string;
  expiredAt: Date;
  submittedAt: Date | null;
  /**
   * The provider's commitment to what it delivered. Null until submission.
   *
   * The hash and not a link, because there is no link to be had. The SDK offers
   * `getErc8183DeliverableUrl`, which scans the policy's `JobInitialised` event for a
   * `deliverable_url` in its optParams; run against 16 submitted mainnet jobs spread across the
   * whole of job history, it resolved zero. Mainnet providers do not publish the URL there.
   *
   * So this is the honest artefact: a hash anyone can check a delivered file against. A
   * `deliverable_url` column was built and then removed rather than shipped permanently empty,
   * dressed up as evidence.
   */
  deliverableHash: string | null;
}

/**
 * The verdict policy a hire must bind, resolved against the chain.
 *
 * Not a constant, because the address the SDK pins is only correct on some chains. See the note
 * on `policyWhitelist` in abi.ts: an unwhitelisted policy cannot be bound, and an unbound policy
 * means the kernel will not fund the job at all.
 */
export interface EscrowPolicy {
  address: Address;
  /** Seconds a delivered job is held before the escrow can be released. */
  disputeWindowSeconds: number;
  /**
   * False when no known policy on this chain is whitelisted.
   *
   * Hiring is impossible in that state, and it is reported rather than thrown so a caller can
   * say so plainly instead of offering a button that cannot work.
   */
  usable: boolean;
}

export interface Erc8183JobReader {
  chainId: number;
  addresses: Erc8183Addresses;
  /** Explorer base for this chain, so callers never hardcode a host. */
  explorerUrl: string;
  /** Highest minted job id, which for a 1-indexed counter is also the count. */
  jobCounter(): Promise<number>;
  /** The policy the router will accept here, and its dispute window. Resolved once. */
  escrowPolicy(): Promise<EscrowPolicy>;
  /** Reads the given ids. Jobs that fail to decode are skipped, not guessed at. */
  readJobs(ids: readonly number[]): Promise<JobRead[]>;
}

/**
 * A policy observed bound to a real funded job on BSC testnet, and whitelisted there.
 *
 * The fallback when the SDK's pinned address is not accepted. Taken from testnet job 500 rather
 * than guessed, and only ever used after `policyWhitelist` confirms it, so this going stale in
 * turn degrades to "hiring unavailable" rather than to a job that cannot be funded.
 */
const OBSERVED_TESTNET_POLICY = '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA' as const;

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

/** Kernel timestamps are unix seconds; 0 means unset rather than 1970. */
const toDate = (seconds: bigint): Date | null =>
  seconds === 0n ? null : new Date(Number(seconds) * 1000);

interface RawJob {
  id: bigint;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: string;
  submittedAt: bigint;
  deliverable: string;
}

function toJobRead(raw: RawJob, chainId: number): JobRead {
  return {
    chainId,
    jobId: Number(raw.id),
    clientAddress: raw.client.toLowerCase(),
    providerAddress: raw.provider.toLowerCase(),
    evaluatorAddress: raw.evaluator.toLowerCase(),
    budgetRaw: raw.budget.toString(),
    status: raw.status,
    statusName: JOB_STATUS[raw.status] ?? 'UNKNOWN',
    description: raw.description,
    /*
     * `expiredAt` is required by the kernel, so a zero here would mean a job we misread. Kept
     * as the epoch rather than coerced, so it shows up as wrong instead of as plausible.
     */
    expiredAt: toDate(raw.expiredAt) ?? new Date(0),
    submittedAt: toDate(raw.submittedAt),
    deliverableHash: raw.deliverable === ZERO_BYTES32 ? null : raw.deliverable,
  };
}

export interface JobReaderOptions {
  env: Env;
  logger: Logger;
  /**
   * Shared with the registry reader when one is already open, or a getter for one.
   *
   * A getter because the Altana network picks its endpoint by probing, so its client only exists
   * after a round trip. Resolving that at construction would put an RPC call in the server's
   * startup path for a feature that may never be used.
   */
  client?: PublicClient | (() => Promise<PublicClient>);
  /**
   * Which chain's kernel to read, defaulting to the registry's.
   *
   * Overridable because two callers want different chains for good reasons. Indexing must read
   * the chain the catalogue was built from, or provider addresses would be matched to agents that
   * live somewhere else. Hiring must read the chain the user's session is on, because that is
   * where their job will exist. In production those are the same chain and this is redundant; on
   * testnet they are not, and collapsing them would either index nothing or verify the wrong
   * kernel.
   */
  chainId?: number;
  /** Explorer base for `chainId`, when it is not the registry's chain. */
  explorerUrl?: string;
}

export function createErc8183JobReader({
  env,
  logger,
  client: shared,
  chainId: chainIdOverride,
  explorerUrl: explorerOverride,
}: JobReaderOptions): Erc8183JobReader {
  const getClient =
    typeof shared === 'function' ? shared : (): Promise<PublicClient> => Promise.resolve(shared ?? createBscClient(env));
  const chainId = chainIdOverride ?? REGISTRY_CHAIN.id;
  const addresses = erc8183Addresses(chainId);

  /**
   * Resolved once and reused. It is a property of the deployment, so re-reading it per request
   * would put two contract calls on the critical path of rendering a page.
   *
   * Cached as the promise rather than the result, so concurrent first requests share one probe.
   * Cleared on failure below, so an RPC blip does not poison it for the process lifetime.
   */
  let policy: Promise<EscrowPolicy> | null = null;

  const resolvePolicy = async (): Promise<EscrowPolicy> => {
    try {
      const client = await getClient();

      for (const candidate of [addresses.policy, OBSERVED_TESTNET_POLICY]) {
        const whitelisted = await client.readContract({
          address: addresses.router,
          abi: routerAbi,
          functionName: 'policyWhitelist',
          args: [candidate],
        });
        if (!whitelisted) continue;

        const window = await client.readContract({
          address: candidate,
          abi: policyAbi,
          functionName: 'disputeWindow',
        });

        if (candidate !== addresses.policy) {
          logger.warn(
            { pinned: addresses.policy, using: candidate },
            'the SDK ERC-8183 policy is not whitelisted on this chain; using an observed one',
          );
        }

        return { address: candidate, disputeWindowSeconds: Number(window), usable: true };
      }

      /*
       * Reported rather than thrown. Escrow history still reads fine without a usable policy —
       * only commissioning new work needs one — so this degrades the hire path alone.
       */
      logger.warn(
        { router: addresses.router, pinned: addresses.policy },
        'no whitelisted ERC-8183 policy found; hiring through escrow is unavailable',
      );
      return { address: addresses.policy, disputeWindowSeconds: 0, usable: false };
    } catch (error) {
      policy = null;
      throw upstreamUnavailable('could not resolve the ERC-8183 escrow policy', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    chainId,
    addresses,
    explorerUrl: explorerOverride ?? REGISTRY_CHAIN.blockExplorers.default.url,

    async jobCounter() {
      try {
        const counter = await (await getClient()).readContract({
          address: addresses.commerce,
          abi: commerceAbi,
          functionName: 'jobCounter',
        });
        return Number(counter);
      } catch (error) {
        throw upstreamUnavailable('could not read the ERC-8183 job counter', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },

    escrowPolicy: () => (policy ??= resolvePolicy()),

    async readJobs(ids) {
      if (ids.length === 0) return [];

      const chunks: number[][] = [];
      for (let i = 0; i < ids.length; i += JOB_MULTICALL_CHUNK) {
        chunks.push([...ids.slice(i, i + JOB_MULTICALL_CHUNK)]);
      }

      const client = await getClient();
      const out: JobRead[] = [];
      let absent = 0;

      // Waves, matching the registry reader: bounded in flight, order preserved.
      for (let i = 0; i < chunks.length; i += JOB_MULTICALL_CONCURRENCY) {
        const wave = chunks.slice(i, i + JOB_MULTICALL_CONCURRENCY);

        let settled: { status: 'success' | 'failure'; result?: unknown }[][];
        try {
          settled = await Promise.all(
            wave.map((slice) =>
              client.multicall({
                allowFailure: true,
                contracts: slice.map((jobId) => ({
                  address: addresses.commerce,
                  abi: commerceAbi,
                  functionName: 'getJob',
                  args: [BigInt(jobId)] as const,
                })),
              }),
            ),
          );
        } catch (error) {
          /*
           * A whole wave failing is the transport, not the data. Thrown so a sweep records how
           * far it genuinely got rather than treating the rest of the range as absent.
           */
          throw upstreamUnavailable('could not read ERC-8183 jobs', {
            cause: error instanceof Error ? error.message : String(error),
          });
        }

        settled.forEach((results, waveIndex) => {
          const requested = wave[waveIndex] ?? [];

          results.forEach((entry, slot) => {
            const askedFor = requested[slot];
            if (askedFor === undefined) return;

            if (entry.status !== 'success' || entry.result === undefined) {
              absent += 1;
              return;
            }

            const raw = entry.result as RawJob;

            /*
             * THE GUARD THAT KEEPS INVENTED JOBS OUT.
             *
             * Reading an id the kernel has never minted does not revert. Solidity returns the
             * zero value for a missing mapping entry, so `getJob(999999)` answers with a
             * well-formed tuple: id 0, the zero address as both client and provider, budget 0,
             * status 0, which happens to name the real status OPEN.
             *
             * Decoded without this check, every id past the counter becomes an identical row
             * claiming job 0 is open with no budget. They would collide on the primary key and,
             * worse, the first one through would be a job that does not exist presented beside
             * jobs that do.
             *
             * Comparing the returned id against the requested one rejects that, and also
             * catches any future misalignment between a multicall's order and its results,
             * which would otherwise attribute one job's budget to another's id.
             */
            if (Number(raw.id) !== askedFor) {
              absent += 1;
              return;
            }

            out.push(toJobRead(raw, chainId));
          });
        });
      }

      /*
       * Expected at the head of a range rather than a fault: `jobCounter` is read before the
       * jobs are, so a sweep can ask for ids that are only minted moments later. Logged,
       * because the jobs that did resolve are still real.
       */
      if (absent > 0) {
        logger.debug({ absent, requested: ids.length }, 'some ERC-8183 jobs were not present');
      }

      return out;
    },
  };
}
