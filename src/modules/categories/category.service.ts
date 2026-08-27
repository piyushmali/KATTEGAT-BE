import { CATEGORY_RULES } from '../classification/taxonomy.js';
import type { CategoryRepository } from './category.repository.js';
import type { ListCategoriesResponse } from './category.schema.js';

/**
 * The marketplace taxonomy, with live counts.
 *
 * Categories are driven by the taxonomy (modules/classification/taxonomy.ts), not
 * by whatever happens to be in the database. A category with zero agents must
 * still be browsable — hiding it the moment it empties is exactly when a user most
 * needs to see "nothing here yet", and it would make the four launch categories
 * appear and disappear as ingestion runs.
 */
export interface CategoryService {
  list(): Promise<ListCategoriesResponse>;
}

const UNCATEGORIZED_DESCRIPTION =
  'Indexed agents the classifier could not confidently place in a category. Shown rather than hidden so gaps in the taxonomy stay visible.';

export function createCategoryService(repository: CategoryRepository): CategoryService {
  return {
    async list(): Promise<ListCategoriesResponse> {
      const [counts, totalAgents] = await Promise.all([
        repository.countByPrimaryCategory(),
        repository.totalAgents(),
      ]);

      const data: ListCategoriesResponse['data'] = CATEGORY_RULES.map((rule) => ({
        id: rule.category,
        label: rule.label,
        description: rule.description,
        agent_count: counts[rule.category] ?? 0,
      }));

      // Only surfaced when it is non-empty: an "Uncategorized" chip with zero
      // agents is noise, but hiding a large bucket would misrepresent the index.
      const uncategorized = counts['uncategorized'] ?? 0;
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
