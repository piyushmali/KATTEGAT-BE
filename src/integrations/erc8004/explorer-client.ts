import { z } from 'zod';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import { upstreamPaymentRequired, upstreamUnavailable } from '../../shared/errors.js';

/**
 * Adapter for the QuickNode ERC-8004 Explorer REST API.
 *
 * Deliberately *not* an `AgentSource`. The Explorer paginates by page number
 * while `AgentSource.discover` walks block ranges, and forcing the two into one
 * interface would give a lowest-common-denominator abstraction that fits neither.
 * The Explorer's actual value is enrichment for an agent we already know about,
 * so that is the shape of this contract.
 *
 * Operational reality, verified against the live docs: every `/v1/*` endpoint is
 * paywalled with x402 at $0.001 USDC per request on Base, and there is no API
 * key to provision. Without a funded x402 signer, calls return HTTP 402. This
 * client therefore stays disabled by default and reports 402 as a distinct,
 * actionable error rather than a generic upstream failure.
 *
 * Rate limits documented upstream: 300 req/min per IP overall, 60 req/min on
 * /v1/agents.
 */

const explorerReputationSchema = z.object({
  score: z.number().nullish(),
  confidence: z.string().nullish(),
  formula_version: z.string().nullish(),
  sub_scores: z
    .object({
      feedback: z.number().nullish(),
      validation: z.number().nullish(),
      sybil_resistance: z.number().nullish(),
      reliability: z.number().nullish(),
    })
    .nullish(),
});

const explorerAgentSchema = z.object({
  agent_id: z.number(),
  chain: z.string().nullish(),
  owner_address: z.string().nullish(),
  agent_uri: z.string().nullish(),
  protocol_tag: z.string().nullish(),
  trait_tags: z.array(z.string()).nullish(),
  metadata: z.unknown().nullish(),
  registered_at: z.string().nullish(),
  feedback_count: z.number().nullish(),
  validation_count: z.number().nullish(),
  avg_validation_response: z.string().nullish(),
  reputation: explorerReputationSchema.nullish(),
});

const envelopeSchema = z.object({ data: explorerAgentSchema });

export type ExplorerAgent = z.infer<typeof explorerAgentSchema>;

/**
 * Explainable reputation as the Explorer computes it.
 *
 * Passed through rather than folded into a single number: the sub-scores are
 * precisely what makes a "why this agent?" panel honest, and collapsing them
 * would recreate the black-box score §23 warns against.
 */
export interface ExplorerReputation {
  score: number | null;
  confidence: string | null;
  formulaVersion: string | null;
  subScores: {
    feedback: number | null;
    validation: number | null;
    sybilResistance: number | null;
    reliability: number | null;
  };
}

export interface AgentEnrichmentSource {
  readonly name: string;
  readonly enabled: boolean;
  /** Null when the agent is unknown upstream (404). */
  fetchAgent(agentId: number, networkSlug?: string): Promise<ExplorerAgent | null>;
  fetchReputation(agentId: number, networkSlug?: string): Promise<ExplorerReputation | null>;
}

export function createExplorerClient(env: Env, logger: Logger): AgentEnrichmentSource {
  const enabled = env.ERC8004_EXPLORER_ENABLED;
  const base = env.ERC8004_EXPLORER_BASE_URL.replace(/\/$/, '');

  /** Returns null for "not configured" and for upstream 404. */
  async function request(path: string, query: Record<string, string>): Promise<unknown> {
    if (!enabled) {
      // Not an error: the free chain reader is the default path, and callers
      // treat a null enrichment as "no extra data", not a failure.
      return null;
    }

    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      throw upstreamUnavailable('ERC-8004 Explorer is unreachable', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.status === 402) {
      // The operator fix is "fund and configure an x402 signer", not a code change.
      throw upstreamPaymentRequired(
        'ERC-8004 Explorer requires an x402 micropayment for this request',
        { endpoint: path },
      );
    }
    if (response.status === 404) return null;
    if (response.status === 429) {
      throw upstreamUnavailable('ERC-8004 Explorer rate limit reached', {
        retryAfter: response.headers.get('retry-after'),
      });
    }
    if (!response.ok) {
      throw upstreamUnavailable(`ERC-8004 Explorer returned ${String(response.status)}`);
    }

    const payload: unknown = await response.json();
    return payload;
  }

  async function fetchAgent(agentId: number, networkSlug?: string): Promise<ExplorerAgent | null> {
    const payload = await request(
      `/v1/agents/${String(agentId)}`,
      networkSlug ? { network: networkSlug } : {},
    );
    if (payload === null) return null;

    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) {
      // A schema drift upstream must not take the marketplace down; the chain
      // reader already supplied everything required.
      logger.warn({ agentId }, 'ERC-8004 Explorer response did not match expected shape');
      return null;
    }

    return parsed.data.data;
  }

  async function fetchReputation(
    agentId: number,
    networkSlug?: string,
  ): Promise<ExplorerReputation | null> {
    const payload = await request(
      `/v1/agents/${String(agentId)}/reputation`,
      networkSlug ? { network: networkSlug } : {},
    );
    if (payload === null) return null;

    const parsed = z.object({ data: explorerReputationSchema }).safeParse(payload);
    if (!parsed.success) {
      logger.warn({ agentId }, 'ERC-8004 Explorer reputation response did not match expected shape');
      return null;
    }

    const data = parsed.data.data;
    return {
      score: data.score ?? null,
      confidence: data.confidence ?? null,
      formulaVersion: data.formula_version ?? null,
      subScores: {
        feedback: data.sub_scores?.feedback ?? null,
        validation: data.sub_scores?.validation ?? null,
        sybilResistance: data.sub_scores?.sybil_resistance ?? null,
        reliability: data.sub_scores?.reliability ?? null,
      },
    };
  }

  return { name: 'erc8004:explorer', enabled, fetchAgent, fetchReputation };
}
