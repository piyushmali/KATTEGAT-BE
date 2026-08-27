import { z } from 'zod';
import type { Logger } from 'pino';
import { toPagination } from '../../shared/http/api.schema.js';
import type { AiProvider } from '../../integrations/ai/provider.js';
import { toWireAgent } from '../agents/agent.mapper.js';
import type { AgentRepository } from '../agents/agent.repository.js';
import { AGENT_CATEGORIES, type AgentCategory } from '../classification/taxonomy.js';
import { parseSearchIntent, type SearchIntent } from './search.intent.js';
import type { SearchQuery, SearchResponse } from './search.schema.js';

/**
 * Natural-language agent search.
 *
 * The deterministic parser does the work. The model is consulted for exactly one
 * thing — picking a category when the rules found none — and only when a provider
 * is configured. That keeps search fast, free and reproducible for the queries
 * that matter, while still handling vocabulary the taxonomy has not seen
 * ("something to stop me getting liquidated").
 *
 * Every model answer is validated against the known category list before it is
 * used, so a hallucinated category is discarded rather than surfaced. If the call
 * fails, times out or returns nonsense, the deterministic result stands.
 */

export interface SearchService {
  search(query: SearchQuery): Promise<SearchResponse>;
}

export interface SearchServiceDeps {
  repository: AgentRepository;
  /** Null when AI_PROVIDER=none, which is the default. */
  ai: AiProvider | null;
  logger: Logger;
}

/** The model may only answer with a known category, or decline. */
const aiCategorySchema = z.object({
  category: z.enum([...AGENT_CATEGORIES, 'none']),
  reason: z.string().max(300).optional(),
});

const AI_SYSTEM_PROMPT = [
  'You map a marketplace search query to exactly one category of autonomous DeFi agent.',
  'Allowed categories: rebalancing, grid-trading, yield-optimization, health-factor-monitoring.',
  'Reply with JSON only: {"category":"<one of the allowed values or none>","reason":"<short>"}.',
  'Answer "none" unless the query clearly indicates one category. Do not guess.',
].join(' ');

export function createSearchService({ repository, ai, logger }: SearchServiceDeps): SearchService {
  /** Returns a category the model is confident about, or null. */
  async function assistWithAi(query: string): Promise<{ category: AgentCategory; reason: string } | null> {
    if (!ai) return null;

    try {
      const raw = await ai.complete({
        system: AI_SYSTEM_PROMPT,
        user: query,
        temperature: 0,
        maxOutputTokens: 120,
      });

      // Models commonly wrap JSON in prose or a code fence; take the first object.
      const match = /\{[\s\S]*\}/.exec(raw);
      if (!match) return null;

      const parsed = aiCategorySchema.safeParse(JSON.parse(match[0]));
      if (!parsed.success || parsed.data.category === 'none') return null;
      if (parsed.data.category === 'uncategorized') return null;

      return {
        category: parsed.data.category,
        reason: parsed.data.reason ?? 'model matched this category',
      };
    } catch (error) {
      // Search must never fail because an optional enrichment did.
      logger.debug({ err: error }, 'AI search assist unavailable; using deterministic intent only');
      return null;
    }
  }

  return {
    async search(query: SearchQuery): Promise<SearchResponse> {
      const intent: SearchIntent = parseSearchIntent(query.q);
      let resolvedBy: 'rules' | 'ai-assisted' = 'rules';

      if (intent.category === null) {
        const assisted = await assistWithAi(query.q);
        if (assisted) {
          intent.category = assisted.category;
          intent.explanation.push(`Category "${assisted.category}" inferred by model: ${assisted.reason}`);
          resolvedBy = 'ai-assisted';
        }
      }

      const result = await repository.list({
        filters: {
          ...(intent.text ? { query: intent.text } : {}),
          ...(intent.category ? { category: intent.category } : {}),
          ...(intent.protocol ? { protocolTag: intent.protocol as never } : {}),
          ...(intent.traits.length > 0 ? { traits: intent.traits } : {}),
          ...(intent.resolvedOnly ? { resolvedOnly: true } : {}),
        },
        sort: intent.sort,
        direction: intent.direction,
        page: query.page,
        perPage: query.per_page,
      });

      return {
        data: result.agents.map(toWireAgent),
        meta: {
          ...toPagination(result.total, query.page, query.per_page),
          interpretation: {
            query: query.q,
            resolved_by: resolvedBy,
            filters: {
              text: intent.text,
              category: intent.category,
              protocol: intent.protocol,
              traits: intent.traits,
              resolved_only: intent.resolvedOnly,
              sort: intent.sort,
              direction: intent.direction,
            },
            explanation: intent.explanation,
          },
        },
      };
    },
  };
}
