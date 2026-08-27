import { count, eq } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import { agentCategories, agents } from '../../infrastructure/database/schema.js';

/**
 * Persistence for the categories domain.
 *
 * These two aggregates previously lived on the agents repository, which meant the
 * categories endpoint reached through another domain to answer its own question.
 * Each module owning the queries it needs keeps the dependency direction honest,
 * even when both read from the same tables.
 */
export interface CategoryRepository {
  /** Count of agents per *primary* category. */
  countByPrimaryCategory(): Promise<Record<string, number>>;
  /** Total indexed agents, for the marketplace-wide denominator. */
  totalAgents(): Promise<number>;
}

export function createCategoryRepository(db: Database): CategoryRepository {
  return {
    async countByPrimaryCategory(): Promise<Record<string, number>> {
      const rows = await db
        .select({ category: agentCategories.category, value: count() })
        .from(agentCategories)
        // Primary only: counting secondary assignments too would make the
        // category counts sum to more than the number of agents.
        .where(eq(agentCategories.isPrimary, true))
        .groupBy(agentCategories.category);

      return Object.fromEntries(rows.map((row) => [row.category, row.value]));
    },

    async totalAgents(): Promise<number> {
      const [row] = await db.select({ value: count() }).from(agents);
      return row?.value ?? 0;
    },
  };
}
