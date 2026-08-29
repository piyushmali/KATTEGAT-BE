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

export function toWireAgent(agent: AgentSummary): AgentSummaryResponse {
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
  };
}
