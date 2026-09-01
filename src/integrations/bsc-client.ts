import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import type { Env } from '../config/env.js';

/**
 * The read client for the chain KATTEGAT indexes.
 *
 * One place, because two integrations now read the same chain for different standards:
 * ERC-8004 for who an agent is and what clients said about it, ERC-8183 for the escrowed jobs
 * it was paid for. Both want the same endpoints and the same retry policy, and a second copy
 * of that policy is how the two end up disagreeing about how long to wait.
 *
 * Also the one place that decides which chain "the registry" means. Jobs are linked to agents
 * by provider address, and an address is only meaningful within a chain, so reading the two
 * standards from different chains would silently produce links that are not real.
 */

/**
 * BNB Smart Chain. Not configurable, unlike the Altana session network.
 *
 * The distinction is deliberate. The Altana account stack runs its sandbox on BSC testnet, so
 * `ALTANA_NETWORK` selects where sessions are granted. The agent registry this marketplace is
 * built on is mainnet, and there is no testnet equivalent holding the same agents, so pointing
 * indexing at another chain would not give a test fixture, it would give an empty catalogue.
 */
export const REGISTRY_CHAIN = bsc;

/**
 * `fallback` rotates to the next endpoint on transport errors, which is the whole of our RPC
 * resilience story (docs/integrations.md). `rank: false` keeps the configured order rather
 * than reordering by latency, so the primary endpoint stays primary.
 */
export function createBscClient(env: Env): PublicClient {
  const endpoints = [env.BSC_RPC_URL, env.BSC_RPC_URL_FALLBACK].filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  );

  return createPublicClient({
    chain: REGISTRY_CHAIN,
    transport: fallback(
      endpoints.map((url) => http(url, { timeout: 15_000, retryCount: 2 })),
      { rank: false },
    ),
  });
}
