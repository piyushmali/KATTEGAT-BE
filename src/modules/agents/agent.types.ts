import type { ProtocolTag } from '../../integrations/erc8004/registration-file.js';
import type { AgentCategory } from '../classification/taxonomy.js';

/**
 * KATTEGAT's internal agent model.
 *
 * Split along the boundaries in docs/architecture.md rather than collapsed into
 * one `Agent` object: identity comes from chain, the profile comes from an
 * off-chain document that may be missing, categories are derived by us, and
 * reputation is a point-in-time snapshot. Those four have different freshness,
 * different failure modes and different owners, so they stay separate.
 */

/**
 * Re-exported for convenience: these vocabularies are owned elsewhere —
 * `ProtocolTag` by the ERC-8004 integration that derives it, `AgentCategory` by
 * the classification taxonomy that defines it — and an agent merely carries them.
 */
export type { ProtocolTag, AgentCategory };

/** On-chain facts. Always present for an indexed agent. */
export interface AgentIdentity {
  /** `${chainId}:${agentId}` */
  id: string;
  chainId: number;
  agentId: number;
  ownerAddress: string;
  /** Declared payment wallet, null when the agent never set one. */
  walletAddress: string | null;
  agentUri: string | null;
  registeredAtBlock: number | null;
  registeredAt: Date | null;
}

/** Off-chain descriptive data. May be unresolved — see `metadataResolvedAt`. */
export interface AgentProfile {
  name: string;
  description: string | null;
  capabilities: string[];
  protocolTag: ProtocolTag;
  traitTags: string[];
  /** Null when the registration file could not be fetched or parsed. */
  metadataResolvedAt: Date | null;
}

/** One classification result with the evidence that produced it. */
export interface AgentCategoryAssignment {
  category: AgentCategory;
  /** 0..1 heuristic confidence. Not a probability. */
  confidence: number;
  isPrimary: boolean;
  /** Why this matched, e.g. `capability:rebalance`. Rendered in the UI. */
  signals: string[];
  classifierVersion: string;
}

/**
 * Reputation as reported by the ERC-8004 ReputationRegistry.
 *
 * `summaryValue` / `summaryDecimals` are kept as the registry returned them.
 * `score` is the decoded convenience value; it is null when there is no
 * feedback, which is different from a score of zero and must stay
 * distinguishable in the UI.
 */
export interface AgentReputation {
  feedbackCount: number;
  clientCount: number;
  summaryValue: number | null;
  summaryDecimals: number | null;
  score: number | null;
  source: string;
  computedAt: Date;
}

/** What the API returns for a list row. */
export interface AgentSummary {
  identity: AgentIdentity;
  profile: AgentProfile;
  categories: AgentCategoryAssignment[];
  reputation: AgentReputation | null;
}

/** Decodes the registry's fixed-point pair into a real number. */
export function decodeSummaryValue(value: number | null, decimals: number | null): number | null {
  if (value === null || decimals === null) return null;
  return value / 10 ** decimals;
}
