import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import {
  agentCategories,
  agentJobs,
  agentSessions,
  agents,
  syncState,
} from '../../infrastructure/database/schema.js';

/**
 * Reads for campaign verification, all keyed on a wallet address.
 *
 * EVERY COMPARISON IS CASE-INSENSITIVE, AND THAT IS NOT DEFENSIVE
 *
 * The two tables disagree about casing, today, in production. `agents.owner_address` is
 * lowercased by the indexer; `agent_sessions.wallet_address` is stored exactly as the browser
 * reported it, which is EIP-55 checksummed — so the same wallet appears as
 * `0x3e5f6a…` in one table and `0x3e5F6aE4…` in the other.
 *
 * An `eq` on either column would therefore return nothing for a wallet that genuinely hired, and
 * the failure is silent: a verifier reads "no hires" and concludes the user did not complete the
 * quest. That is the worst outcome this endpoint can produce, so both sides go through `lower()`
 * rather than trusting the caller to guess a casing.
 *
 * ponytail: `lower()` on the column defeats the plain btree index on `owner_address`, which for a
 * 325k-row table is a scan. Acceptable because this endpoint is called per wallet by a verifier,
 * not per page view by visitors. The upgrade path is an expression index on
 * `lower(owner_address)`, which is one migration if the call rate ever justifies it.
 */

export interface TrackedSessionRow {
  publicKey: string;
  agentId: string;
  agentName: string;
  walletAddress: string;
  spendLimitWei: string;
  spendPeriod: string;
  allowedCalls: string[];
  grantedAt: Date;
  grantedTxHash: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedTxHash: string | null;
}

export interface TrackedAgentRow {
  agentId: string;
  name: string;
  registeredAt: Date | null;
  registeredAtBlock: number | null;
  registrationTxHash: string | null;
}

export interface TrackedJobRow {
  id: string;
  chainId: number;
  jobId: number;
  providerAddress: string;
  /** The kernel's status index. Named by the service, the same way job.mapper does it. */
  status: number;
  budgetRaw: string;
  /**
   * When KATTEGAT last read this job from the kernel — not when it was created.
   *
   * The kernel exposes no creation timestamp and the table stores none, so there is no honest
   * "funded at" to report. The job id is sequential and the status is read from chain, which
   * together are what a verifier actually needs.
   */
  lastSyncedAt: Date | null;
}

export interface TrackingRepository {
  /** Every session this wallet granted, newest first, with the agent it was granted for. */
  hiresByWallet(walletAddress: string): Promise<TrackedSessionRow[]>;
  /** Agents in the catalogue whose on-chain owner is this wallet. */
  agentsByOwner(walletAddress: string, limit: number): Promise<TrackedAgentRow[]>;
  /** Escrowed jobs this wallet paid for. */
  jobsByClient(walletAddress: string, limit: number): Promise<TrackedJobRow[]>;
  /** Categories for a set of agent ids, so hires and listings can both be labelled. */
  categoriesFor(
    agentIds: string[],
  ): Promise<Map<string, { category: string; isPrimary: boolean }[]>>;
  /** When the indexer last advanced, so a missing new agent has a stated explanation. */
  lastIndexedAt(): Promise<Date | null>;
}

export function createTrackingRepository(db: Database): TrackingRepository {
  return {
    async hiresByWallet(walletAddress) {
      return db
        .select({
          publicKey: agentSessions.publicKey,
          agentId: agentSessions.agentId,
          agentName: agents.name,
          walletAddress: agentSessions.walletAddress,
          spendLimitWei: agentSessions.spendLimitWei,
          spendPeriod: agentSessions.spendPeriod,
          allowedCalls: agentSessions.allowedCalls,
          grantedAt: agentSessions.grantedAt,
          grantedTxHash: agentSessions.grantedTxHash,
          expiresAt: agentSessions.expiresAt,
          revokedAt: agentSessions.revokedAt,
          revokedTxHash: agentSessions.revokedTxHash,
        })
        .from(agentSessions)
        .innerJoin(agents, eq(agents.id, agentSessions.agentId))
        .where(sql`lower(${agentSessions.walletAddress}) = lower(${walletAddress})`)
        .orderBy(desc(agentSessions.grantedAt));
    },

    async agentsByOwner(walletAddress, limit) {
      return (
        db
          .select({
            agentId: agents.id,
            name: agents.name,
            registeredAt: agents.registeredAt,
            registeredAtBlock: agents.registeredAtBlock,
            /*
             * The proof for the builder half of the quest.
             *
             * Without it, "this wallet listed an agent" is a claim a verifier has to take on
             * trust or go and check against the registry themselves. The transaction shows the
             * owner address in its own logs, so it answers the question directly.
             */
            registrationTxHash: agents.registrationTxHash,
          })
          .from(agents)
          .where(sql`lower(${agents.ownerAddress}) = lower(${walletAddress})`)
          /*
           * By id descending rather than registration time: `registered_at` is null for nearly
           * every row because the ID-walk backfill records no block timestamp, so ordering by it
           * would be arbitrary. Ids are assigned in registration order, so this is the same
           * ordering the missing column would have given.
           */
          .orderBy(desc(agents.agentId))
          .limit(limit)
      );
    },

    async jobsByClient(walletAddress, limit) {
      return db
        .select({
          id: agentJobs.id,
          chainId: agentJobs.chainId,
          jobId: agentJobs.jobId,
          providerAddress: agentJobs.providerAddress,
          status: agentJobs.status,
          budgetRaw: agentJobs.budgetRaw,
          lastSyncedAt: agentJobs.lastSyncedAt,
        })
        .from(agentJobs)
        .where(sql`lower(${agentJobs.clientAddress}) = lower(${walletAddress})`)
        .orderBy(desc(agentJobs.jobId))
        .limit(limit);
    },

    async categoriesFor(agentIds) {
      const grouped = new Map<string, { category: string; isPrimary: boolean }[]>();
      if (agentIds.length === 0) return grouped;

      const rows = await db
        .select({
          agentId: agentCategories.agentId,
          category: agentCategories.category,
          isPrimary: agentCategories.isPrimary,
        })
        .from(agentCategories)
        /*
         * `inArray`, not a hand-written `= ANY(...)`. Interpolating a JS array into a `sql`
         * template expands it into one placeholder per element, so `= ANY(${ids})` becomes
         * `= ANY($1, $2)` — invalid SQL, and a 500 on every wallet that had actually hired while a
         * wallet with no history returned 200 from the empty-array early return. The shape of the
         * bug hid it: the quiet path worked and the meaningful one did not.
         */
        .where(inArray(agentCategories.agentId, agentIds));

      for (const row of rows) {
        const existing = grouped.get(row.agentId) ?? [];
        existing.push({ category: row.category, isPrimary: row.isPrimary });
        grouped.set(row.agentId, existing);
      }
      return grouped;
    },

    async lastIndexedAt() {
      const [row] = await db
        .select({ at: syncState.lastSuccessAt })
        .from(syncState)
        .orderBy(desc(syncState.lastSuccessAt))
        .limit(1);
      return row?.at ?? null;
    },
  };
}
