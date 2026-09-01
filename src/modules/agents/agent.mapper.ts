import { toWireJobSummary } from '../jobs/job.mapper.js';
import type { JobRepository, JobSummary } from '../jobs/job.repository.js';
import type { AgentSummary } from './agent.types.js';
import type { AgentSummaryResponse } from './agent.schema.js';

/**
 * Domain model to wire format.
 *
 * Its own file because more than one module returns agents — the agents module
 * and the search module both do — and duplicating the camelCase/snake_case
 * mapping is how two endpoints end up disagreeing about the same entity.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * Maps a page of agents and attaches each one's escrow history.
 *
 * A function rather than leaving callers to `.map(toWireAgent)` with their own lookup, because
 * both the browse list and search return agents and job evidence has to appear on both. An
 * agent that shows delivered work when browsed and none when searched would look like the
 * evidence was made up.
 *
 * It also removes a trap. `agents.map(toWireAgent)` passes the array index as the second
 * argument, so widening the mapper to take a second parameter would silently hand it `0`, `1`,
 * `2` as job summaries.
 */
export async function toWireAgentPage(
  agents: readonly AgentSummary[],
  jobs: Pick<JobRepository, 'summariesForAgents'>,
): Promise<AgentSummaryResponse[]> {
  const summaries = await jobs.summariesForAgents(agents.map((agent) => agent.identity.id));
  return agents.map((agent) => toWireAgent(agent, summaries.get(agent.identity.id) ?? null));
}

export function toWireAgent(
  agent: AgentSummary,
  jobs: JobSummary | null = null,
): AgentSummaryResponse {
  return {
    identity: {
      id: agent.identity.id,
      chain_id: agent.identity.chainId,
      agent_id: agent.identity.agentId,
      owner_address: agent.identity.ownerAddress,
      wallet_address: agent.identity.walletAddress,
      agent_uri: agent.identity.agentUri,
      registered_at_block: agent.identity.registeredAtBlock,
      registered_at: iso(agent.identity.registeredAt),
    },
    profile: {
      name: agent.profile.name,
      description: agent.profile.description,
      capabilities: agent.profile.capabilities,
      protocol_tag: agent.profile.protocolTag,
      trait_tags: agent.profile.traitTags,
      image_url: agent.profile.imageUrl,
      endpoints: agent.profile.endpoints,
      trust_models: agent.profile.trustModels,
      x402_support: agent.profile.x402Support,
      declared_active: agent.profile.declaredActive,
      metadata_resolved_at: iso(agent.profile.metadataResolvedAt),
    },
    categories: agent.categories.map((assignment) => ({
      category: assignment.category,
      confidence: assignment.confidence,
      is_primary: assignment.isPrimary,
      signals: assignment.signals,
      classifier_version: assignment.classifierVersion,
    })),
    reputation: agent.reputation
      ? {
          feedback_count: agent.reputation.feedbackCount,
          client_count: agent.reputation.clientCount,
          summary_value: agent.reputation.summaryValue,
          summary_decimals: agent.reputation.summaryDecimals,
          score: agent.reputation.score,
          source: agent.reputation.source,
          computed_at: agent.reputation.computedAt.toISOString(),
        }
      : null,
    jobs: jobs === null ? null : toWireJobSummary(jobs),
  };
}
