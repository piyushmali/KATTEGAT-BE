import type { Logger } from 'pino';
import { notFound } from '../../shared/errors.js';
import type { AgentSource } from '../../integrations/agent-source.js';
import type { AgentEnrichmentSource } from '../../integrations/erc8004/explorer-client.js';
import type { AgentReputationResponse } from './reputation.schema.js';
import type { ReputationRepository, StoredReputation } from './reputation.repository.js';

/**
 * Live reputation reads.
 *
 * Its own module because reputation has a different freshness contract from the
 * rest of an agent record. The list endpoint serves the snapshot ingestion wrote,
 * which is fine for browsing; this endpoint reads the registry directly, because
 * the moment a user is deciding whether to trust an agent is the moment a stale
 * number is most expensive.
 *
 * Fallback order — the strategy §43 of the brief asks for:
 *
 *   1. ReputationRegistry on BNB Smart Chain (free, authoritative)
 *   2. the cached snapshot, clearly labelled as such
 *   3. explorer enrichment layered on top when configured, never as the base
 *
 * A failure at step 1 degrades the answer and says so in `notes`; it never
 * fabricates a score and never 500s on an agent we already have data for.
 */

export interface ReputationService {
  getForAgent(agentId: string): Promise<AgentReputationResponse>;
}

export interface ReputationServiceDeps {
  repository: ReputationRepository;
  source: AgentSource;
  explorer: AgentEnrichmentSource;
  logger: Logger;
}

const decode = (value: number | null, decimals: number | null): number | null =>
  value === null || decimals === null ? null : value / 10 ** decimals;

export function createReputationService({
  repository,
  source,
  explorer,
  logger,
}: ReputationServiceDeps): ReputationService {
  return {
    async getForAgent(agentId: string): Promise<AgentReputationResponse> {
      const numericId = await repository.findAgentNumericId(agentId);
      if (numericId === null) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const notes: string[] = [];
      let snapshot: StoredReputation | null = null;
      let origin: 'chain' | 'snapshot' = 'chain';

      try {
        const live = await source.reputation(numericId);
        if (live) {
          snapshot = {
            feedbackCount: live.feedbackCount,
            clientCount: live.clientCount,
            summaryValue: live.summaryValue,
            summaryDecimals: live.summaryDecimals,
            computedAt: live.computedAt,
          };
          // Refresh the cache so a later failure has something recent to fall back to.
          await repository.saveSnapshot(agentId, { ...snapshot, source: live.source });
        }
      } catch (error) {
        logger.warn({ agentId, err: error }, 'live reputation read failed; falling back to snapshot');
        notes.push('Live registry read failed; showing the most recent cached reading.');
        origin = 'snapshot';
      }

      if (!snapshot) {
        snapshot = await repository.findSnapshot(agentId);
        origin = 'snapshot';
      }

      if (!snapshot) {
        // Indexed but never scored: an honest empty reading beats a 404, because
        // the agent does exist and "no feedback" is the answer.
        return {
          data: {
            agent_id: agentId,
            feedback_count: 0,
            client_count: 0,
            summary_value: null,
            summary_decimals: null,
            score: null,
            origin: 'snapshot',
            computed_at: new Date().toISOString(),
            notes: [...notes, 'No reputation has been recorded for this agent yet.'],
            explorer: null,
          },
        };
      }

      if (snapshot.feedbackCount === 0) {
        notes.push('No client feedback recorded on chain yet.');
      }

      // Enrichment is strictly additive and never allowed to break the response.
      let explorerData: AgentReputationResponse['data']['explorer'] = null;
      if (explorer.enabled) {
        try {
          const enriched = await explorer.fetchReputation(numericId);
          if (enriched) {
            explorerData = {
              score: enriched.score,
              confidence: enriched.confidence,
              formula_version: enriched.formulaVersion,
              sub_scores: {
                feedback: enriched.subScores.feedback,
                validation: enriched.subScores.validation,
                sybil_resistance: enriched.subScores.sybilResistance,
                reliability: enriched.subScores.reliability,
              },
            };
          }
        } catch (error) {
          logger.debug({ agentId, err: error }, 'explorer reputation enrichment unavailable');
          notes.push('Third-party explorer enrichment was unavailable for this reading.');
        }
      }

      return {
        data: {
          agent_id: agentId,
          feedback_count: snapshot.feedbackCount,
          client_count: snapshot.clientCount,
          summary_value: snapshot.summaryValue,
          summary_decimals: snapshot.summaryDecimals,
          score: decode(snapshot.summaryValue, snapshot.summaryDecimals),
          origin,
          computed_at: snapshot.computedAt.toISOString(),
          notes,
          explorer: explorerData,
        },
      };
    },
  };
}
