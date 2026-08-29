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
import { safeImageUrl } from '../../modules/agents/agent.types.js';
import type {
  AgentSource,
  AgentSourceCursor,
  DiscoveredAgent,
  DiscoveryPage,
} from '../agent-source.js';
import { identityRegistryAbi, reputationRegistryAbi } from './abi.js';
import { decodeScore } from '../../modules/reputation/score.js';
import type { ProtocolTag } from './registration-file.js';
import { loadRegistrationFile, needsNetworkFetch } from './registration-file.js';

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

/**
 * How many registration files to fetch at once.
 *
 * Raised from 5 after measuring the corpus. Most agents cost nothing here — 82% of the
 * registry publishes an inline `data:` URI needing no network at all, and IPFS accounts
 * for well under 1% — so the old limit was throttling the whole walk to protect gateways
 * it barely touches.
 *
 * Not raised further, and the reason is the shape of the data: the 7,936 fetchable
 * agents point at only 23 distinct hosts, so concurrency here lands on a handful of
 * origins rather than spreading out. 12 keeps the average per host low enough to stay
 * a polite client while roughly doubling throughput on a fetch-heavy stretch.
 *
 * ponytail: a flat limit, not a per-host pool. The ceiling is that an unlucky batch can
 * put all 12 slots on one origin. Upgrade path if that ever matters: key the limiter by
 * hostname.
 */
const METADATA_CONCURRENCY = 12;

/**
 * Agent ids per Multicall3 request during an ID-walk backfill.
 *
 * `tokenURI` returns a full URI per agent, so the response grows fast; 120 keeps a
 * single call comfortably inside typical RPC response limits.
 */
const ID_MULTICALL_CHUNK = 120;

/**
 * Multicall chunks in flight at once, per method.
 *
 * The walk is latency-bound: a BSC round trip from here measures ~1.4s against Alchemy,
 * publicnode and the public dataseed alike, so the endpoint is not the problem and
 * waiting on one chunk at a time simply leaves the connection idle.
 *
 * Three methods are read concurrently, so the real ceiling is 3x this — twelve
 * simultaneous requests, which is well within what an RPC provider expects from one
 * client and still far below anything that would look abusive.
 */
const ID_MULTICALL_CONCURRENCY = 4;

export interface ChainReaderOptions {
  env: Env;
  logger: Logger;
}

/** Options for the ID-walk discovery path. */
export interface IdRangeOptions {
  /**
   * Record agents whose registration file lives behind an HTTPS or IPFS URL without
   * fetching it, leaving `metadataResolvedAt` null for a later backlog pass.
   *
   * Inline `data:` URIs are resolved regardless — they need no network.
   */
  deferNetworkMetadata?: boolean;
}

/** The profile fields a registration file contributes, once resolved. */
export interface ResolvedProfile {
  name: string | null;
  description: string | null;
  capabilities: string[];
  protocolTag: ProtocolTag;
  traitTags: string[];
  rawMetadata: unknown;
}

/**
 * An agent found on chain, before its off-chain registration file is resolved.
 *
 * Both discovery strategies produce this shape so they can share one resolver.
 * `registeredAt*` are nullable because the ID-walk path never reads the log that
 * carries the block, and guessing would be worse than admitting it.
 */
interface AgentCandidate {
  agentId: number;
  agentUri: string | null;
  owner: string;
  walletAddress: string | null;
  registeredAtBlock: number | null;
  registeredAt: Date | null;
}

/** Adds chain-specific helpers the generic `AgentSource` contract has no use for. */
export interface ChainAgentSource extends AgentSource {
  /**
   * Highest minted agent id, which for ERC-8004's sequential counter is also the
   * total number of agents ever registered.
   */
  highestAgentId(): Promise<number>;
  /**
   * Discovers agents by id instead of by log replay. The backfill path — reaches
   * the whole registry, where log replay is bounded by RPC log retention.
   */
  discoverByIdRange(fromId: number, toId: number, options?: IdRangeOptions): Promise<DiscoveryPage>;
  /** Resolves one deferred registration file. Used by the metadata backlog pass. */
  resolveRegistration(agentUri: string): Promise<ResolvedProfile>;
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

    const page = await resolveCandidates(
      hits.map((hit) => ({
        agentId: Number(hit.agentId),
        agentUri: hit.agentUri.length > 0 ? hit.agentUri : null,
        owner: hit.owner,
        walletAddress: wallets.get(hit.agentId) ?? null,
        registeredAtBlock: Number(hit.blockNumber),
        registeredAt: timestamps.get(hit.blockNumber) ?? null,
      })),
    );

    return { ...page, cursor: processedTo };
  }

  /**
   * Turns on-chain candidates into domain agents by resolving their registration
   * files.
   *
   * Shared by both discovery strategies — log replay and ID walk — so the two
   * cannot disagree about how an agent is normalised or how a broken metadata
   * document is handled.
   */
  async function resolveCandidates(
    candidates: AgentCandidate[],
    deferNetworkMetadata = false,
  ): Promise<Omit<DiscoveryPage, 'cursor'>> {
    const agents: DiscoveredAgent[] = [];
    const unresolved: { id: string; reason: string }[] = [];

    for (let i = 0; i < candidates.length; i += METADATA_CONCURRENCY) {
      const batch = candidates.slice(i, i + METADATA_CONCURRENCY);

      const resolved = await Promise.all(
        batch.map(async (candidate) => {
          const numericId = candidate.agentId;
          const id = toGlobalId(numericId);

          const identity = {
            id,
            chainId: bsc.id,
            agentId: numericId,
            ownerAddress: candidate.owner.toLowerCase(),
            walletAddress: candidate.walletAddress,
            agentUri: candidate.agentUri,
            registeredAtBlock: candidate.registeredAtBlock,
            registeredAt: candidate.registeredAt,
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
                  imageUrl: null,
                  metadataResolvedAt: null,
                },
                rawMetadata: null,
              },
              failure: { id, reason: 'no agentURI set on chain' },
            };
          }

          /*
           * Deferred fetch. The agent is recorded now with its URI intact and metadata
           * marked unresolved, and a later pass retrieves the document.
           *
           * This is what stops a slow third party from throttling discovery. Measured on
           * the live registry, reading 1,200 agents over Multicall3 takes about four
           * seconds while the pass takes sixty-five — and one host,
           * `metadata.evoevo.ai`, serves ~90% of the fetches in some id ranges at 1.25s
           * each. Their latency was setting the rate at which our catalogue could grow,
           * which is the wrong coupling.
           *
           * Inline `data:` URIs are never deferred: they are a base64 decode with no
           * network involved, and they are 82% of the registry, so discovery still
           * resolves most metadata immediately.
           */
          if (deferNetworkMetadata && needsNetworkFetch(identity.agentUri, env.IPFS_GATEWAY_URL)) {
            return {
              agent: {
                identity,
                profile: {
                  name: `Agent #${String(numericId)}`,
                  description: null,
                  capabilities: [],
                  protocolTag: 'unconfigured' as const,
                  traitTags: [],
                  imageUrl: null,
                  metadataResolvedAt: null,
                },
                rawMetadata: null,
              },
              // Not a failure. Nothing has been attempted yet, and the backlog pass
              // finds this row by its null `metadataResolvedAt`.
              failure: null,
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
                  imageUrl: safeImageUrl(registration.file.image),
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
                  imageUrl: null,
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

    return { agents, unresolved };
  }

  /**
   * Fetches and interprets one registration file.
   *
   * Exposed for the metadata backlog pass, which retries the documents discovery chose
   * to defer. Errors propagate: the caller decides whether a given failure means "record
   * this as unresolved" or "stop", and it has the agent id to log against.
   */
  async function resolveRegistration(agentUri: string): Promise<ResolvedProfile> {
    const registration = await loadRegistrationFile(agentUri, env.IPFS_GATEWAY_URL);

    return {
      name: registration.file.name?.trim() ?? null,
      description: registration.file.description?.trim() ?? null,
      capabilities: registration.capabilities,
      protocolTag: registration.protocolTag,
      traitTags: registration.traitTags,
      rawMetadata: registration.file,
    };
  }

  /**
   * Highest minted agent id, found by bisecting `ownerOf`.
   *
   * ERC-8004 mints ids from a sequential counter, so the highest minted id is also
   * the agent count. `ownerOf` reverts for an id that was never minted, which makes
   * the boundary bisectable in ~20 calls.
   */
  async function highestAgentId(): Promise<number> {
    const exists = async (id: number): Promise<boolean> => {
      try {
        await client.readContract({
          address: identityAddress,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [BigInt(id)],
        });
        return true;
      } catch {
        return false;
      }
    };

    if (!(await exists(1))) return 0;

    // Grow an upper bound first: the registry's size is unknown, and doubling
    // finds a ceiling in log(n) calls without assuming a maximum.
    let low = 1;
    let high = 2;
    while (await exists(high)) {
      low = high;
      high *= 2;
      if (high > 1_000_000_000) break;
    }

    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (await exists(mid)) low = mid;
      else high = mid;
    }

    return low;
  }

  /**
   * Discovers agents by walking ids rather than replaying logs.
   *
   * This is the backfill path, and it exists because log replay cannot reach the
   * registry's history: free RPC tiers retain only a short window of logs (~8k
   * blocks on publicnode) and Alchemy's free tier caps `eth_getLogs` at 10 blocks.
   * Ids, by contrast, are readable with plain `eth_call` on any endpoint with no
   * retention limit at all — so the full registry is reachable this way.
   *
   * The trade-off is that `registeredAt` is unknown here: the timestamp lives in the
   * `Registered` log we are deliberately not reading. It is left null rather than
   * guessed. Ids are monotonic with registration order, so the repository falls back
   * to ordering by agent id when the date is missing.
   */
  async function discoverByIdRange(
    fromId: number,
    toId: number,
    options?: IdRangeOptions,
  ): Promise<DiscoveryPage> {
    const start = Math.max(1, fromId);
    if (toId < start) return { agents: [], cursor: start - 1, unresolved: [] };

    const ids = Array.from({ length: toId - start + 1 }, (_, index) => BigInt(start + index));

    /**
     * Reads one method for every id, chunked.
     *
     * Chunking is not optional: a single Multicall3 call bundling thousands of
     * `tokenURI` reads returns megabytes and exceeds the node's response limit, so a
     * large `--limit` would fail as one indivisible request. Chunking makes any limit
     * safe and keeps each response small.
     */
    const read = async <T>(functionName: 'ownerOf' | 'tokenURI' | 'getAgentWallet') => {
      const chunks: bigint[][] = [];
      for (let i = 0; i < ids.length; i += ID_MULTICALL_CHUNK) {
        chunks.push(ids.slice(i, i + ID_MULTICALL_CHUNK));
      }

      const out: { status: 'success' | 'failure'; result?: T }[] = [];

      /*
       * Chunks are pipelined rather than awaited one at a time.
       *
       * Measured from this machine, a BSC round trip costs about 1.4 seconds against
       * every endpoint tried — Alchemy, publicnode and the public dataseed alike — so
       * this is latency, not a slow provider. Awaiting ten chunks in series spent that
       * 1.4s ten times over per method and left the connection idle in between.
       *
       * `tokenURI` makes it worse than pure latency, because 82% of the registry
       * publishes its whole registration file inline as a base64 `data:` URI. Those
       * responses carry real payload, so serialising them wastes bandwidth as well as
       * time.
       *
       * Waves keep order intact while bounding how much is in flight: this runs inside
       * a `Promise.all` over three methods, so the real ceiling is three times the
       * value below.
       */
      for (let i = 0; i < chunks.length; i += ID_MULTICALL_CONCURRENCY) {
        const wave = chunks.slice(i, i + ID_MULTICALL_CONCURRENCY);
        const settled = await Promise.all(
          wave.map((slice) =>
            client.multicall({
              allowFailure: true,
              contracts: slice.map((agentId) => ({
                address: identityAddress,
                abi: identityRegistryAbi,
                functionName,
                args: [agentId] as const,
              })),
            }),
          ),
        );

        for (const results of settled) {
          out.push(...(results as { status: 'success' | 'failure'; result?: T }[]));
        }
      }

      return out;
    };

    let owners: { status: 'success' | 'failure'; result?: string }[];
    let uris: { status: 'success' | 'failure'; result?: string }[];
    let wallets: { status: 'success' | 'failure'; result?: string }[];

    try {
      [owners, uris, wallets] = await Promise.all([
        read<string>('ownerOf'),
        read<string>('tokenURI'),
        read<string>('getAgentWallet'),
      ]);
    } catch (error) {
      throw upstreamUnavailable('multicall for agent ids failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const candidates: AgentCandidate[] = [];

    ids.forEach((agentId, index) => {
      const owner = owners[index];
      // A failed ownerOf means the id was never minted — a gap, not an error.
      if (!owner || owner.status !== 'success' || typeof owner.result !== 'string') return;

      const uri = uris[index];
      const wallet = wallets[index];
      const walletAddress =
        wallet?.status === 'success' && typeof wallet.result === 'string'
          ? wallet.result === ZERO_ADDRESS
            ? null
            : wallet.result.toLowerCase()
          : null;
      const agentUri =
        uri?.status === 'success' && typeof uri.result === 'string' && uri.result.length > 0
          ? uri.result
          : null;

      candidates.push({
        agentId: Number(agentId),
        agentUri,
        owner: owner.result,
        walletAddress,
        registeredAtBlock: null,
        registeredAt: null,
      });
    });

    const page = await resolveCandidates(candidates, options?.deferNetworkMetadata ?? false);
    return { ...page, cursor: toId };
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
      const hasFeedback = feedbackCount > 0;

      return {
        feedbackCount,
        clientCount: clients.length,
        summaryValue: hasFeedback ? rawValue : null,
        summaryDecimals: hasFeedback ? decimals : null,
        score: hasFeedback ? decodeScore(rawValue, decimals) : null,
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
    highestAgentId,
    discoverByIdRange,
    resolveRegistration,
  };
}

export const SOURCE_NAME = 'erc8004:bsc:chain';
