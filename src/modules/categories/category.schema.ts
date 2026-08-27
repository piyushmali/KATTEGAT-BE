import { z } from 'zod';
import { AGENT_CATEGORIES } from '../classification/taxonomy.js';

/** Wire contract for the categories domain. */

export const categorySchema = z.object({
  id: z.enum(AGENT_CATEGORIES),
  label: z.string(),
  description: z.string(),
  /** Agents whose *primary* category this is. */
  agent_count: z.number().int(),
});

export const listCategoriesResponseSchema = z.object({
  data: z.array(categorySchema),
  meta: z.object({ total_agents: z.number().int() }),
});

export type CategoryResponse = z.infer<typeof categorySchema>;
export type ListCategoriesResponse = z.infer<typeof listCategoriesResponseSchema>;
