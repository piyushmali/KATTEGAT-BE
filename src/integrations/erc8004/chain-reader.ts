import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbiItem,
  type PublicClient,
} from 'viem';
import { bsc } from 'viem/chains';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import { upstreamUnavailable } from '../../shared/errors.js';
import type { AgentReputation } from '../../modules/agents/agent.types.js';
import type {
  AgentSource,
  AgentSourceCursor,
  DiscoveredAgent,
  DiscoveryPage,
} from '../agent-source.js';
import { identityRegistryAbi, reputationRegistryAbi } from './abi.js';
import { loadRegistrationFile } from './registration-file.js';

/**
 * Reads agents straight from the ERC-8004 registries on BNB Smart Chain.
 *
 * This is KATTEGAT's primary source, chosen over the ERC-8004 Explorer REST API
 * because that API is paywalled per request via x402 and cannot underpin a
 * reliable demo. Reading the registries costs nothing but an RPC call and is the
 * authoritative record either way.
 *
 * The one constraint that shapes this whole file: the identity registry is *not*
 * ERC721Enumerable — `totalSupply()` reverts — so agents can only be discovered
 * by replaying `Registered` logs from the registry's deploy block.
 */

const REGISTERED_EVENT = parseAbiItem(
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** How many registration files to fetch at once. Keeps IPFS gateways happy. */
const METADATA_CONCURRENCY = 5;

export interface ChainReaderOptions {
  env: Env;
  logger: Logger;
}

/** Adds chain-specific helpers the generic `AgentSource` contract has no use for. */
export interface ChainAgentSource extends AgentSource {
  /**
   * Oldest block this endpoint will actually serve `eth_getLogs` for.
   *
   * Free BSC endpoints keep only a short log window and answer anything older
   * with an archive-access error. Probing for the real boundary lets a sync ask
   * for the widest range that can succeed instead of failing on the first window.
   */
  oldestAvailableLogBlock(): Promise<number>;
  /** Registry `name()` — a cheap end-to-end proof that config points somewhere real. */
  registryName(): Promise<string>;
  /** Resolves the block a sync should start from, clamped to what the node serves. */
  resolveStartBlock(preferredFrom: number): Promise<{ fromBlock: number; clamped: boolean }>;
}

export function createChainReader({ env, logger }: ChainReaderOptions): ChainAgentSource {
  const endpoints = [env.BSC_RPC_URL, env.BSC_RPC_URL_FALLBACK].filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  );

  // `fallback` rotates to the next endpoint on transport errors, which is the
  // whole of our RPC resilience story (docs/integrations.md).
  const client: PublicClient = createPublicClient({
    chain: bsc,
    transport: fallback(
      endpoints.map((url) => http(url, { timeout: 15_000, retryCount: 2 })),
      { rank: false },
    ),
  });

  const identityAddress = getAddress(env.ERC8004_IDENTITY_REGISTRY);
  const reputationAddress = getAddress(env.ERC8004_REPUTATION_REGISTRY);

  const toGlobalId = (agentId: number): string => `${String(bsc.id)}:${String(agentId)}`;

  async function latestBlock(): Promise<number> {
    try {
      return Number(await client.getBlockNumber());
    } catch (error) {
      throw upstreamUnavailable('BNB Smart Chain RPC is unreachable', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Block timestamps for the blocks we actually saw, fetched once each. */
  async function blockTimestamps(blockNumbers: bigint[]): Promise<Map<bigint, Date>> {
    const unique = [...new Set(blockNumbers)];
    const entries = new Map<bigint, Date>();

    for (let i = 0; i < unique.length; i += METADATA_CONCURRENCY) {
      const batch = unique.slice(i, i + METADATA_CONCURRENCY);
      const blocks = await Promise.allSettled(
        batch.map((blockNumber) => client.getBlock({ blockNumber, includeTransactions: false })),
      );

      blocks.forEach((result, index) => {
        const blockNumber = batch[index];
        if (blockNumber === undefined) return;
        if (result.status === 'fulfilled') {
          entries.set(blockNumber, new Date(Number(result.value.timestamp) * 1_000));
        }
      });
    }

    return entries;
  }

  async function discover(cursor: AgentSourceCursor): Promise<DiscoveryPage> {
    const head = cursor.toBlock ?? (await latestBlock());
    const from = Math.max(0, cursor.fromBlock);

    if (from > head) {
      return { agents: [], cursor: head, unresolved: [] };
    }

    type RegisteredHit = {
      agentId: bigint;
      agentUri: string;
      owner: string;
      blockNumber: bigint;
    };

    const hits: RegisteredHit[] = [];
    const chunk = env.ERC8004_LOG_CHUNK_SIZE;
    let processedTo = from - 1;

    // Public BSC endpoints reject wide eth_getLogs ranges, so walk in windows and
    // remember how far we actually got — a mid-scan failure must not be recorded
    // as "synced to head".
    for (let start = from; start <= head; start += chunk) {
      const end = Math.min(start + chunk - 1, head);

      try {
        const logs = await client.getLogs({
          address: identityAddress,
          event: REGISTERED_EVENT,
          fromBlock: BigInt(start),
          toBlock: BigInt(end),
        });

        for (const log of logs) {
          const { agentId, agentURI, owner } = log.args;
          if (agentId === undefined || owner === undefined) continue;
          hits.push({
            agentId,
            agentUri: agentURI ?? '',
            owner: getAddress(owner),
            blockNumber: log.blockNumber,
          });
        }

        processedTo = end;
      } catch (error) {
        logger.warn(
          { fromBlock: start, toBlock: end, err: error },
          'eth_getLogs window failed; stopping scan at last good block',
        );
        break;
      }
    }

    if (processedTo < from) {
      throw upstreamUnavailable('could not read any Registered logs from BNB Smart Chain');
    }

    const timestamps = await blockTimestamps(hits.map((hit) => hit.blockNumber));
    const wallets = await agentWallets(hits.map((hit) => hit.agentId));

    const agents: DiscoveredAgent[] = [];
    const unresolved: { id: string; reason: string }[] = [];

    for (let i = 0; i < hits.length; i += METADATA_CONCURRENCY) {
      const batch = hits.slice(i, i + METADATA_CONCURRENCY);

      const resolved = await Promise.all(
        batch.map(async (hit) => {
          const numericId = Number(hit.agentId);
          const id = toGlobalId(numericId);
          const wallet = wallets.get(hit.agentId) ?? null;
          const registeredAt = timestamps.get(hit.blockNumber) ?? null;

          const identity = {
            id,
            chainId: bsc.id,
            agentId: numericId,
            ownerAddress: hit.owner.toLowerCase(),
            walletAddress: wallet,
            agentUri: hit.agentUri.length > 0 ? hit.agentUri : null,
            registeredAtBlock: Number(hit.blockNumber),
            registeredAt,
          };

          if (identity.agentUri === null) {
            // Registered via `register()` with the URI set later, or never set.
            return {
              agent: {
                identity,
                profile: {
                  name: `Agent #${String(numericId)}`,
                  description: null,
                  capabilities: [],
                  protocolTag: 'unconfigured' as const,
                  traitTags: [],
                  metadataResolvedAt: null,
                },
                rawMetadata: null,
              },
              failure: { id, reason: 'no agentURI set on chain' },
            };
          }

          try {
            const registration = await loadRegistrationFile(
              identity.agentUri,
              env.IPFS_GATEWAY_URL,
            );

            return {
              agent: {
                identity,
                profile: {
                  name: registration.file.name?.trim() ?? `Agent #${String(numericId)}`,
                  description: registration.file.description?.trim() ?? null,
                  capabilities: registration.capabilities,
                  protocolTag: registration.protocolTag,
                  traitTags: registration.traitTags,
                  metadataResolvedAt: new Date(),
                },
                rawMetadata: registration.file,
              },
              failure: null,
            };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logger.debug({ agentId: numericId, reason }, 'registration file unresolved');

            // A broken metadata document degrades one agent, it does not fail the
            // sync. The row is still useful: identity is on-chain and verified.
            return {
              agent: {
                identity,
                profile: {
                  name: `Agent #${String(numericId)}`,
                  description: null,
                  capabilities: [],
                  protocolTag: 'unconfigured' as const,
                  traitTags: [],
                  metadataResolvedAt: null,
                },
                rawMetadata: null,
              },
              failure: { id, reason },
            };
          }
        }),
      );

      for (const entry of resolved) {
        agents.push(entry.agent);
        if (entry.failure) unresolved.push(entry.failure);
      }
    }

    return { agents, cursor: processedTo, unresolved };
  }

  /** Batched `getAgentWallet` reads. Falls back to per-call on multicall failure. */
  async function agentWallets(agentIds: bigint[]): Promise<Map<bigint, string | null>> {
    const wallets = new Map<bigint, string | null>();
    if (agentIds.length === 0) return wallets;

    const unique = [...new Set(agentIds)];

    try {
      const results = await client.multicall({
        allowFailure: true,
        contracts: unique.map((agentId) => ({
          address: identityAddress,
          abi: identityRegistryAbi,
          functionName: 'getAgentWallet' as const,
          args: [agentId] as const,
        })),
      });

      results.forEach((result, index) => {
        const agentId = unique[index];
        if (agentId === undefined) return;
        if (result.status === 'success' && typeof result.result === 'string') {
          const address = result.result;
          wallets.set(agentId, address === ZERO_ADDRESS ? null : address.toLowerCase());
        } else {
          wallets.set(agentId, null);
        }
      });
    } catch (error) {
      logger.warn({ err: error }, 'multicall for agent wallets failed; continuing without them');
      for (const agentId of unique) wallets.set(agentId, null);
    }

    return wallets;
  }

  async function reputation(agentId: number): Promise<AgentReputation | null> {
    const id = BigInt(agentId);

    let clients: readonly string[];
    try {
      clients = await client.readContract({
        address: reputationAddress,
        abi: reputationRegistryAbi,
        functionName: 'getClients',
        args: [id],
      });
    } catch (error) {
      throw upstreamUnavailable('reputation registry read failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const now = new Date();

    // getSummary reverts with "clientAddresses required" on an empty list, so an
    // agent with no feedback is answered here rather than by a failed call.
    if (clients.length === 0) {
      return {
        feedbackCount: 0,
        clientCount: 0,
        summaryValue: null,
        summaryDecimals: null,
        score: null,
        source: SOURCE_NAME,
        computedAt: now,
      };
    }

    try {
      const [count, summaryValue, summaryDecimals] = await client.readContract({
        address: reputationAddress,
        abi: reputationRegistryAbi,
        functionName: 'getSummary',
        args: [id, clients as readonly `0x${string}`[], '', ''],
      });

      const feedbackCount = Number(count);
      // The registry returns a fixed-point average. Both halves are preserved;
      // dividing here without keeping `decimals` would lose the precision the
      // caller needs to render the value faithfully.
      const decimals = Number(summaryDecimals);
      const rawValue = Number(summaryValue);
      const hasScore = feedbackCount > 0;

      return {
        feedbackCount,
        clientCount: clients.length,
        summaryValue: hasScore ? rawValue : null,
        summaryDecimals: hasScore ? decimals : null,
        score: hasScore ? rawValue / 10 ** decimals : null,
        source: SOURCE_NAME,
        computedAt: now,
      };
    } catch (error) {
      throw upstreamUnavailable('reputation summary read failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function registryName(): Promise<string> {
    return client.readContract({
      address: identityAddress,
      abi: identityRegistryAbi,
      functionName: 'name',
    });
  }

  /**
   * Bisects for the oldest block whose logs this endpoint will serve.
   *
   * Deliberately probes `eth_getLogs` rather than `eth_getCode`. Bisecting on
   * `eth_getCode` was the obvious way to find the registry's deploy block, but
   * every free BSC endpoint tested rejects historical state reads outright
   * ("Archive requests require a personal token"), which makes that bisection
   * converge on the chain head and report a deploy block ~100 blocks old. Logs
   * are retained separately from state, so probing them finds a boundary that is
   * real. Costs ~14 requests.
   */
  async function oldestAvailableLogBlock(): Promise<number> {
    const head = await latestBlock();

    const servesLogs = async (blockNumber: number): Promise<boolean> => {
      try {
        await client.getLogs({
          address: identityAddress,
          event: REGISTERED_EVENT,
          fromBlock: BigInt(blockNumber),
          toBlock: BigInt(Math.min(blockNumber + 10, head)),
        });
        return true;
      } catch {
        return false;
      }
    };

    const floor = Math.max(0, head - env.ERC8004_MAX_LOOKBACK_BLOCKS);
    if (await servesLogs(floor)) return floor;

    // Somewhere between `floor` (rejected) and `head` (assumed fine) lies the
    // retention boundary. Find the lowest block that answers.
    let low = floor;
    let high = head;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (await servesLogs(mid)) high = mid;
      else low = mid + 1;
    }

    return low;
  }

  async function resolveStartBlock(
    preferredFrom: number,
  ): Promise<{ fromBlock: number; clamped: boolean }> {
    const oldest = await oldestAvailableLogBlock();
    if (preferredFrom >= oldest) {
      return { fromBlock: preferredFrom, clamped: false };
    }
    // Asking for more history than the endpoint holds would fail every window.
    // Clamping and reporting it is better than importing nothing silently.
    return { fromBlock: oldest, clamped: true };
  }

  return {
    name: SOURCE_NAME,
    chainId: bsc.id,
    latestBlock,
    discover,
    reputation,
    oldestAvailableLogBlock,
    registryName,
    resolveStartBlock,
  };
}

export const SOURCE_NAME = 'erc8004:bsc:chain';
