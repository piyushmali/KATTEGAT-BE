import { JOB_STATUS } from '@altananetwork/sdk';
import type { ResolvedNetwork } from '../../integrations/altana/network.js';
import type { TrackingRepository } from './tracking.repository.js';
import { QUEST_CATEGORIES, type WalletTrackingResponse } from './tracking.schema.js';

/**
 * Campaign verification for one wallet.
 *
 * The question this answers is narrow: did this wallet hire an agent in each of the four
 * campaign categories on KATTEGAT, and did it list an agent of its own. Everything else in the
 * response is the evidence behind that answer, so the verdict can be checked rather than taken.
 */

/** Bounded so one wallet with an unusual history cannot return an unbounded document. */
const MAX_LISTED_AGENTS = 200;
const MAX_JOBS = 200;

export interface TrackingService {
  forWallet(walletAddress: string): Promise<WalletTrackingResponse>;
}

export interface TrackingServiceOptions {
  repository: TrackingRepository;
  /** Where hiring settles, reported so a verifier reads the chain rather than assuming it. */
  network: ResolvedNetwork;
  /** The chain the catalogue is indexed from, which is not the hiring chain. */
  registryChainId: number;
  identityRegistry: string;
}

/**
 * Revoked, expired, or live — derived rather than stored.
 *
 * Deliberately not read back from the Keystore here. `listForAgent` does that, because a user
 * looking at their own authority needs to know if it was revoked somewhere else. A verifier
 * checking quest completion is asking a historical question, and making it wait on one chain read
 * per hire would turn a single request into dozens. `granted_tx_hash` is on every entry for
 * anyone who wants to confirm independently.
 */
function statusOf(hire: { revokedAt: Date | null; expiresAt: Date }, now: Date) {
  if (hire.revokedAt !== null) return 'revoked' as const;
  return hire.expiresAt.getTime() <= now.getTime() ? ('expired' as const) : ('active' as const);
}

export function createTrackingService({
  repository,
  network,
  registryChainId,
  identityRegistry,
}: TrackingServiceOptions): TrackingService {
  return {
    async forWallet(walletAddress) {
      const [hires, listed, jobs, lastIndexedAt] = await Promise.all([
        repository.hiresByWallet(walletAddress),
        repository.agentsByOwner(walletAddress, MAX_LISTED_AGENTS),
        repository.jobsByClient(walletAddress, MAX_JOBS),
        repository.lastIndexedAt(),
      ]);

      // One lookup for both lists, since a wallet can own an agent it also hired.
      const categories = await repository.categoriesFor([
        ...new Set([...hires.map((h) => h.agentId), ...listed.map((a) => a.agentId)]),
      ]);

      /** Assignments for one agent, primary first, with `uncategorized` treated as absent. */
      const labelled = (agentId: string) => {
        const rows = (categories.get(agentId) ?? []).filter(
          (row) => row.category !== 'uncategorized',
        );
        const primary = rows.find((row) => row.isPrimary) ?? rows[0];
        return {
          primary: primary?.category ?? null,
          all: rows.map((row) => row.category),
        };
      };

      const now = new Date();

      const hireEntries = hires.map((hire) => {
        const { primary, all } = labelled(hire.agentId);
        return {
          agent_id: hire.agentId,
          agent_name: hire.agentName,
          primary_category: primary,
          categories: all,
          session_public_key: hire.publicKey,
          wallet_address: hire.walletAddress,
          spend_limit_wei: hire.spendLimitWei,
          spend_period: hire.spendPeriod,
          allowed_calls: hire.allowedCalls,
          granted_at: hire.grantedAt.toISOString(),
          granted_tx_hash: hire.grantedTxHash,
          expires_at: hire.expiresAt.toISOString(),
          revoked_at: hire.revokedAt?.toISOString() ?? null,
          revoked_tx_hash: hire.revokedTxHash,
          status: statusOf(hire, now),
        };
      });

      /*
       * Credit is given for every category the agent carries, not just its primary one. An agent
       * classified as both yield and rebalancing genuinely does both, and the campaign asks
       * whether the wallet hired in a category rather than which label we happened to rank first.
       */
      const hiredCategories = new Set(hireEntries.flatMap((hire) => hire.categories));
      const categoriesHired = QUEST_CATEGORIES.filter((category) => hiredCategories.has(category));
      const categoriesMissing = QUEST_CATEGORIES.filter(
        (category) => !hiredCategories.has(category),
      );
      const hiredAllFour = categoriesMissing.length === 0;
      const listedAnAgent = listed.length > 0;

      return {
        data: {
          wallet_address: walletAddress,
          quest: {
            required_categories: [...QUEST_CATEGORIES],
            categories_hired: categoriesHired,
            categories_missing: categoriesMissing,
            hired_all_four: hiredAllFour,
            agents_listed_count: listed.length,
            listed_an_agent: listedAnAgent,
            complete: hiredAllFour && listedAnAgent,
          },
          hires: hireEntries,
          agents_listed: listed.map((agent) => ({
            agent_id: agent.agentId,
            name: agent.name,
            registered_at: agent.registeredAt?.toISOString() ?? null,
            registered_at_block: agent.registeredAtBlock,
            registration_tx_hash: agent.registrationTxHash,
            categories: labelled(agent.agentId).all,
          })),
          escrow_jobs: jobs.map((job) => ({
            id: job.id,
            chain_id: job.chainId,
            job_id: job.jobId,
            provider_address: job.providerAddress,
            /*
             * The name, not the index, and `UNKNOWN` rather than a guess if the kernel adds a
             * status. Same rule as job.mapper: an unrecognised state reported honestly beats one
             * mapped onto its neighbour and read as "settled".
             */
            status: JOB_STATUS[job.status] ?? 'UNKNOWN',
            budget_raw: job.budgetRaw,
            last_synced_at: job.lastSyncedAt?.toISOString() ?? null,
          })),
        },
        meta: {
          hiring_chain_id: network.config.chain.id,
          network: network.name,
          registry_chain_id: registryChainId,
          identity_registry: identityRegistry,
          keystore_address: network.config.keyStore,
          hire_definition:
            'A hire is an Altana session key granted by the user passkey and registered in the ' +
            'public Keystore, then verified against that Keystore before being recorded here. ' +
            'The session is scoped to contract addresses and a spend ceiling, so the chain does ' +
            'not record which agent it was for: that pairing is held by KATTEGAT and is what this ' +
            'endpoint reports. Use granted_tx_hash to verify the grant itself on chain.',
          catalogue_last_indexed_at: lastIndexedAt?.toISOString() ?? null,
        },
      };
    },
  };
}
