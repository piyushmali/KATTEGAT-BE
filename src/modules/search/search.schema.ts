import { z } from 'zod';
import { paginationSchema } from '../../shared/http/api.schema.js';
import { agentCategoryEnum, agentSummarySchema } from '../agents/agent.schema.js';

/** Wire contract for the search domain. */

export const searchQuerySchema = z.object({
  /** A natural-language request, e.g. "conservative yield agent with a track record". */
  q: z.string().trim().min(1).max(300),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(24),
});

/**
 * How the query was read.
 *
 * `filters` is the structured query actually executed and `explanation` is the
 * plain-language account of how it was derived. Both are returned so the user can
 * see and correct the interpretation instead of wondering why a result appeared —
 * the same "no black box" requirement the classification signals satisfy.
 */
export const searchInterpretationSchema = z.object({
  query: z.string(),
  /** `rules` or `ai-assisted`; see modules/search/search.service.ts. */
  resolved_by: z.enum(['rules', 'ai-assisted']),
  /**
   * True when the residual free text was dropped to avoid returning nothing.
   *
   * After a category is lifted out of a sentence, what remains is often grammar rather than
   * a term anyone chose, and ANDing it against descriptions can zero out a good category
   * match. Reported so the UI can say the query was widened instead of showing results that
   * do not match the filters it claims.
   */
  widened: z.boolean(),
  filters: z.object({
    text: z.string().nullable(),
    category: agentCategoryEnum.nullable(),
    protocol: z.string().nullable(),
    traits: z.array(z.string()),
    resolved_only: z.boolean(),
    sort: z.string(),
    direction: z.string(),
  }),
  explanation: z.array(z.string()),
});

export const searchResponseSchema = z.object({
  data: z.array(agentSummarySchema),
  meta: paginationSchema.extend({ interpretation: searchInterpretationSchema }),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
