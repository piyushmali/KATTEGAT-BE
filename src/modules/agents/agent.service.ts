import { notFound } from '../../shared/errors.js';
import { toPagination } from '../../shared/http/api.schema.js';
import type { JobRepository } from '../jobs/job.repository.js';
import { toWireAgent, toWireAgentPage } from './agent.mapper.js';
import type { AgentRepository, ListAgentsFilters } from './agent.repository.js';
import type {
  AgentFilterQuery,
  AgentSummaryResponse,
  ListAgentsQuery,
  ListAgentsResponse,
} from './agent.schema.js';

/**
 * Application logic for the agents domain.
 *
 * Translates wire queries into repository filters and domain models into wire
 * shapes. Route handlers stay thin, and the repository stays unaware of the HTTP
 * contract.
 */

export interface AgentService {
  list(query: ListAgentsQuery): Promise<ListAgentsResponse>;
  getById(id: string): Promise<{ data: AgentSummaryResponse }>;
}

/**
 * Maps the shared filter vocabulary onto repository filters.
 *
 * Exported because the search module resolves a natural-language query into the
 * same filter shape and then needs the identical translation — one definition
 * means the two endpoints cannot interpret `trait` or `min_confidence`
 * differently.
 */
export function toRepositoryFilters(query: AgentFilterQuery): ListAgentsFilters {
  const filters: ListAgentsFilters = {};
  if (query.category) filters.category = query.category;
  if (query.protocol) filters.protocolTag = query.protocol;
  if (query.q) filters.query = query.q;
  if (query.trait) filters.traits = query.trait;
  if (query.resolved_only !== undefined) filters.resolvedOnly = query.resolved_only;
  if (query.has_endpoint !== undefined) filters.hasEndpoint = query.has_endpoint;
  if (query.min_confidence !== undefined) filters.minConfidence = query.min_confidence;
  return filters;
}

export function createAgentService(
  repository: AgentRepository,
  jobs: Pick<JobRepository, 'summariesForAgents' | 'summaryForAgent'>,
): AgentService {
  return {
    async list(query: ListAgentsQuery): Promise<ListAgentsResponse> {
      const result = await repository.list({
        filters: toRepositoryFilters(query),
        sort: query.sort,
        direction: query.direction,
        page: query.page,
        perPage: query.per_page,
      });

      return {
        data: await toWireAgentPage(result.agents, jobs),
        meta: toPagination(result.total, query.page, query.per_page),
      };
    },

    async getById(id: string): Promise<{ data: AgentSummaryResponse }> {
      const agent = await repository.findById(id);
      if (!agent) {
        throw notFound(`No agent with id "${id}" has been indexed.`);
      }

      const summary = await jobs.summaryForAgent(id);

      /*
       * Absent rather than zeroed when no job names this agent. A row of zeroes would read as
       * "hired and delivered nothing", which is a different and much worse claim than "not yet
       * hired through the escrow rail".
       */
      return { data: toWireAgent(agent, summary.total === 0 ? null : summary) };
    },
  };
}
