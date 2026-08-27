import type { AgentIdentity, AgentProfile, AgentReputation } from '../modules/agents/agent.types.js';

/**
 * The contract every agent data source implements.
 *
 * This is the boundary instruction §19 asks for: marketplace code depends on
 * this interface, never on a provider's response shape. Today there are two
 * implementations —
 *
 *   - `erc8004/chain-reader.ts`  free, authoritative, reads BNB Smart Chain directly
 *   - `erc8004/explorer-client.ts`  richer, but x402-paywalled per request
 *
 * — and a third (a partner-provided index) could be added without touching the
 * agents module. If the Explorer changes its JSON, only its mapper moves.
 */

export interface DiscoveredAgent {
  identity: AgentIdentity;
  profile: AgentProfile;
  /** The registration file exactly as fetched, for replaying mapper fixes. */
  rawMetadata: unknown;
}

export interface AgentSourceCursor {
  /** Block to resume `Registered` log replay from. */
  fromBlock: number;
  /** Inclusive upper bound; omit to read to the chain head. */
  toBlock?: number;
}

export interface DiscoveryPage {
  agents: DiscoveredAgent[];
  /** Highest block fully processed — persisted to `sync_state.last_block`. */
  cursor: number;
  /** Agents found but whose metadata could not be resolved, with the reason. */
  unresolved: { id: string; reason: string }[];
}

export interface AgentSource {
  /** Stable identifier persisted on each row as provenance. */
  readonly name: string;
  /** Chain this source indexes. */
  readonly chainId: number;

  /** Current chain head, used to bound a sync run. */
  latestBlock(): Promise<number>;

  /** Discovers agents registered within the cursor's block range. */
  discover(cursor: AgentSourceCursor): Promise<DiscoveryPage>;

  /** Reads a single agent's live reputation. Null when the agent is unknown. */
  reputation(agentId: number): Promise<AgentReputation | null>;
}
