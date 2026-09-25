import { CATEGORY_RULES } from '../classification/taxonomy.js';
import type { AgentFilters } from '../agents/agent.filters.js';
import type { CategoryRepository } from './category.repository.js';
import type { ListCategoriesResponse } from './category.schema.js';

/**
 * The marketplace taxonomy, with live counts.
 *
 * Categories are driven by the taxonomy (modules/classification/taxonomy.ts), not by whatever
 * happens to be in the database. A category with zero agents must still be browsable — hiding
 * it the moment it empties is exactly when a user most needs to see "nothing here yet", and it
 * would make the four launch categories appear and disappear as ingestion runs.
 *
 * Counts are scoped to the caller's filters, because these numbers label the discovery grid.
 * An unfiltered count beside a filtered grid describes nothing: before this took filters, the
 * Trading & Execution tab read 135,424 above a total of 6,191, and Model Evaluation claimed
 * 6,217 — more agents in one category than on the whole page.
 */
export interface CategoryService {
  list(filters?: AgentFilters): Promise<ListCategoriesResponse>;
}

const UNCATEGORIZED_DESCRIPTION =
  'Indexed agents the classifier could not confidently place in a category. Shown rather than hidden so gaps in the taxonomy stay visible.';

export function createCategoryService(repository: CategoryRepository): CategoryService {
  return {
    async list(filters: AgentFilters = {}): Promise<ListCategoriesResponse> {
      /*
       * `classifiedOnly` and `category` are both dropped before counting, and for the same
       * reason: the count has to predict what clicking the tab shows, and clicking a tab sets
       * the category while the frontend drops `classified_only`. Counting with either applied
       * would report a number the click then contradicts — with `classifiedOnly` on, the
       * Uncategorized tab would count zero and read as empty when it is the largest bucket.
       */
      const scope: AgentFilters = { ...filters };
      delete scope.category;
      delete scope.classifiedOnly;
      delete scope.minConfidence;

      const [counts, uncategorized, totalAgents] = await Promise.all([
        repository.countByCategory(scope),
        repository.countUncategorized(scope),
        repository.totalAgents(),
      ]);

      const data: ListCategoriesResponse['data'] = CATEGORY_RULES.map((rule) => ({
        id: rule.category,
        label: rule.label,
        description: rule.description,
        agent_count: counts[rule.category] ?? 0,
      }));

      /*
       * Only surfaced when non-empty: an "Uncategorized" chip with zero agents is noise, but
       * hiding a large bucket would misrepresent the index.
       *
       * Counted as the absence of a real category rather than from the stored `uncategorized`
       * rows. 191,302 of those rows were deleted to fit the catalogue inside a 1 GB free tier,
       * so counting them reported 39 agents where the browsable set held 81,827 — a chip whose
       * number and whose contents were both wrong.
       */
      if (uncategorized > 0) {
        data.push({
          id: 'uncategorized',
          label: 'Uncategorized',
          description: UNCATEGORIZED_DESCRIPTION,
          agent_count: uncategorized,
        });
      }

      return { data, meta: { total_agents: totalAgents } };
    },
  };
}
