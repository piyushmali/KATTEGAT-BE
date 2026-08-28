import { z } from 'zod';

/**
 * Wire contract for marketplace statistics.
 *
 * Only counts that can be derived from indexed data. Field names say exactly what
 * they measure — `declared_active` rather than `active`, because the agent claims
 * it, we did not observe it.
 */
export const ecosystemStatsSchema = z.object({
  /** Agents in the index. */
  indexed_agents: z.number().int(),
  /** Agents whose own registration file declares `active: true`. A claim, not an observation. */
  declared_active: z.number().int(),
  /** Agents whose off-chain registration file resolved successfully. */
  with_resolved_metadata: z.number().int(),
  /** Categories containing at least one agent, excluding `uncategorized`. */
  active_categories: z.number().int(),
  /** Agents KATTEGAT placed in a real category. */
  classified_agents: z.number().int(),
  /** Non-revoked on-chain feedback entries across all indexed agents. */
  feedback_records: z.number().int(),
  /** Agents with at least one feedback entry. */
  rated_agents: z.number().int(),
  /** Distinct owner addresses. */
  owner_count: z.number().int(),
  /** Last successful ingestion run, or null if none has completed. */
  last_indexed_at: z.string().nullable(),
});

export const ecosystemStatsResponseSchema = z.object({ data: ecosystemStatsSchema });

export type EcosystemStatsResponse = z.infer<typeof ecosystemStatsResponseSchema>;
