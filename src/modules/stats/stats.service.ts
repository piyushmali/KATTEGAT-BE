import { sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import { agentCategories, agentReputation, agents, syncState } from '../../infrastructure/database/schema.js';
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

export function createStatsService(db: Database): StatsService {
  return {
    async ecosystem(): Promise<EcosystemStatsResponse> {
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
          owner_count: row?.ownerCount ?? 0,
          last_indexed_at: row?.lastIndexedAt ? new Date(row.lastIndexedAt).toISOString() : null,
        },
      };
    },
  };
}
