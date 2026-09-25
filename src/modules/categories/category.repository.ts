import { count, countDistinct, sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import { agentCategories, agents } from '../../infrastructure/database/schema.js';
import { buildAgentWhere, type AgentFilters } from '../agents/agent.filters.js';

/**
 * Persistence for the categories domain.
 *
 * These aggregates previously lived on the agents repository, which meant the categories
 * endpoint reached through another domain to answer its own question. Each module owning the
 * queries it needs keeps the dependency direction honest, even when both read the same tables.
 * The filter *predicate* is still shared from `agents/agent.filters.ts` — owning your queries
 * is not the same as owning a second definition of what a filter means, and that distinction
 * is what went wrong here.
 */
export interface CategoryRepository {
  /**
   * Agents per category, under the same filters the grid has in force.
   *
   * Filter-aware because the tab counts label the grid, and an unfiltered count beside a
   * filtered grid does not describe anything. Measured on the live catalogue before this
   * changed: the Trading & Execution tab read 135,424 above a total of 6,191, and clicking it
   * produced 1,872. Model Evaluation claimed 6,217 against a total of 6,191, so a single
   * category appeared to hold more agents than the whole page.
   */
  countByCategory(filters: AgentFilters): Promise<Record<string, number>>;
  /** Agents matching the filters that have no real category, for the `uncategorized` count. */
  countUncategorized(filters: AgentFilters): Promise<number>;
  /** Total indexed agents, for the marketplace-wide denominator. Deliberately unfiltered. */
  totalAgents(): Promise<number>;
}

export function createCategoryRepository(db: Database): CategoryRepository {
  return {
    async countByCategory(filters): Promise<Record<string, number>> {
      /*
       * `countDistinct` on the agent, not `count()` on the rows.
       *
       * They differ whenever an agent holds the same category twice, which the primary key
       * prevents today — but the reason to count agents is that "how many agents are in this
       * category" is the question the tab is answering, and a count of assignments would stop
       * being that answer the moment the schema allowed a second row.
       *
       * Any assignment, not just the primary one. This is the half of the fix that is about
       * agreement rather than filters: the count used to restrict to `is_primary` while the
       * category filter matched any assignment, so the Rebalancing tab read 130 and clicking it
       * returned 147. An agent that rebalances *and* chases yield belongs in both lists.
       */
      const where = buildAgentWhere(filters, { omitCategory: true });

      const rows = await db
        .select({ category: agentCategories.category, value: countDistinct(agents.id) })
        .from(agentCategories)
        .innerJoin(agents, sql`${agents.id} = ${agentCategories.agentId}`)
        .where(where)
        .groupBy(agentCategories.category);

      return Object.fromEntries(rows.map((row) => [row.category, row.value]));
    },

    async countUncategorized(filters): Promise<number> {
      /*
       * Counted from the agents side, because "uncategorized" is the absence of a category row
       * and absence cannot be grouped over in the query above. Reuses the shared predicate by
       * passing the category through, so this count and the `category=uncategorized` filter are
       * the same question asked twice rather than two definitions.
       */
      const where = buildAgentWhere({ ...filters, category: 'uncategorized' });
      const [row] = await db.select({ value: count() }).from(agents).where(where);
      return row?.value ?? 0;
    },

    async totalAgents(): Promise<number> {
      const [row] = await db.select({ value: count() }).from(agents);
      return row?.value ?? 0;
    },
  };
}
