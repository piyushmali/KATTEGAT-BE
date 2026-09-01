import { sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import {
  agentCategories,
  agentReputation,
  agents,
  syncState,
} from '../../infrastructure/database/schema.js';
import type { EcosystemStatsResponse } from './stats.schema.js';

/**
 * Marketplace-wide counts for the landing page.
 *
 * Every figure is a real `count` against indexed data. There is deliberately no
 * "total value managed", "success rate" or "transactions executed" here: ERC-8004
 * exposes none of those, and inventing one to fill a stat card is exactly what
 * KATTEGAT's evidence-first positioning rules out.
 *
 * One query, not five, because this renders above the fold on every visit.
 */
export interface StatsService {
  ecosystem(): Promise<EcosystemStatsResponse>;
}

/**
 * How long a reading is reused.
 *
 * These are nine aggregates over 317,476 rows, including two `count(distinct …)`, and they
 * measured 586ms against the deployed database. That is paid above the fold on every visit to
 * the landing page, and no index removes it: counting distinct owners means visiting every row.
 *
 * A minute, because the only thing that changes these numbers is an ingestion pass, and the
 * fastest of those runs every thirty. Short enough that nobody sees a figure they would call
 * wrong, long enough that a burst of visitors costs one query rather than one each.
 *
 * The reading stays honest while cached: `last_indexed_at` travels with it, so the payload says
 * how current the underlying index is regardless of when these counts were taken.
 */
const STATS_TTL_MS = 60_000;

export function createStatsService(db: Database): StatsService {
  /*
   * Held as the promise, not the result, so a burst of concurrent first requests shares one
   * query instead of each starting its own. Cleared on failure below, so an error is retried
   * rather than cached for a minute.
   */
  let cached: { value: Promise<EcosystemStatsResponse>; at: number } | null = null;

  async function read(): Promise<EcosystemStatsResponse> {
    const [row] = await db
      .select({
        indexedAgents: sql<number>`(select count(*)::int from ${agents})`,
        /**
         * "Active" means the agent's own registration file declares `active: true`,
         * surfaced as the `declared-active` trait. It is a *claim by the agent*, not
         * an observation of on-chain activity, and the UI must say so.
         */
        declaredActive: sql<number>`(
            select count(*)::int from ${agents}
            where 'declared-active' = any(${agents.traitTags})
          )`,
        /** Agents whose off-chain registration file resolved. */
        withResolvedMetadata: sql<number>`(
            select count(*)::int from ${agents}
            where ${agents.metadataResolvedAt} is not null
          )`,
        /** Categories that actually contain at least one agent. */
        activeCategories: sql<number>`(
            select count(distinct ${agentCategories.category})::int
            from ${agentCategories}
            where ${agentCategories.isPrimary} = true
              and ${agentCategories.category} <> 'uncategorized'
          )`,
        /** Agents KATTEGAT could place in a real category. */
        classifiedAgents: sql<number>`(
            select count(*)::int from ${agentCategories}
            where ${agentCategories.isPrimary} = true
              and ${agentCategories.category} <> 'uncategorized'
          )`,
        /** Non-revoked on-chain feedback entries across every indexed agent. */
        feedbackRecords: sql<number>`(
            select coalesce(sum(${agentReputation.feedbackCount}), 0)::int
            from ${agentReputation}
          )`,
        /** Distinct addresses that have rated an agent. */
        ratedAgents: sql<number>`(
            select count(*)::int from ${agentReputation}
            where ${agentReputation.feedbackCount} > 0
          )`,
        /**
         * Agents whose reputation has actually been read from the registry.
         *
         * The denominator for every feedback figure above, and the reason it is reported.
         * Reputation used to be read only when a visitor opened a profile, so
         * `feedback_records` described KATTEGAT's browsing history rather than the
         * ecosystem, and the landing page had to caveat itself as counting only what
         * happened to have been looked at. With the sweep in place this number says how
         * much of the catalogue the claim covers, so "no feedback" can be reported as a
         * finding instead of an omission.
         */
        reputationSwept: sql<number>`(select count(*)::int from ${agentReputation})`,
        ownerCount: sql<number>`(
            select count(distinct ${agents.ownerAddress})::int from ${agents}
          )`,
        lastIndexedAt: sql<Date | null>`(
            select max(${syncState.lastSuccessAt}) from ${syncState}
          )`,
      })
      .from(sql`(select 1) as anchor`);

    return {
      data: {
        indexed_agents: row?.indexedAgents ?? 0,
        declared_active: row?.declaredActive ?? 0,
        with_resolved_metadata: row?.withResolvedMetadata ?? 0,
        active_categories: row?.activeCategories ?? 0,
        classified_agents: row?.classifiedAgents ?? 0,
        feedback_records: row?.feedbackRecords ?? 0,
        rated_agents: row?.ratedAgents ?? 0,
        reputation_swept: row?.reputationSwept ?? 0,
        owner_count: row?.ownerCount ?? 0,
        last_indexed_at: row?.lastIndexedAt ? new Date(row.lastIndexedAt).toISOString() : null,
      },
    };
  }

  return {
    ecosystem(): Promise<EcosystemStatsResponse> {
      if (cached === null || Date.now() - cached.at > STATS_TTL_MS) {
        cached = {
          at: Date.now(),
          value: read().catch((error: unknown) => {
            cached = null;
            throw error;
          }),
        };
      }

      return cached.value;
    },
  };
}
