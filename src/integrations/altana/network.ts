import { BNB, BNB_TESTNET, type NetworkConfig } from '@altananetwork/sdk';
import { createPublicClient, http, type PublicClient } from 'viem';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import { upstreamUnavailable } from '../../shared/errors.js';

/**
 * Resolving which Altana network hiring runs on, and a read client for it.
 *
 * One place that knows about chains, so going live is a change to `ALTANA_NETWORK` rather
 * than a search through the codebase for hardcoded testnet assumptions. Everything that
 * varies by chain (id, explorer host, native symbol, Keystore address, RPC endpoints) comes
 * from here and is carried to the browser through the API, so the UI never guesses either.
 */

export interface ResolvedNetwork {
  config: NetworkConfig;
  /** `bnb-testnet` or `bnb`, as configured. */
  name: Env['ALTANA_NETWORK'];
  /** What to call the native token in copy. Wrong on the other chain, so not hardcoded. */
  nativeSymbol: 'BNB' | 'tBNB';
  /** True on mainnet, where a mistake spends real money. */
  isMainnet: boolean;
}

export function resolveNetwork(name: Env['ALTANA_NETWORK']): ResolvedNetwork {
  return name === 'bnb'
    ? { config: BNB, name, nativeSymbol: 'BNB', isMainnet: true }
    : { config: BNB_TESTNET, name, nativeSymbol: 'tBNB', isMainnet: false };
}

/**
 * Read endpoints per network, tried in order.
 *
 * The SDK ships one `publicRpcUrl` per network and documents it as overridable, which it
 * needs to be: the packaged testnet default answered a Cloudflare 520 mid-run and failed a
 * Keystore read for a session that had already been granted on chain, so a flaky endpoint
 * reported a failure about authority that existed.
 *
 * The SDK's own default is last in each list rather than absent, so this degrades to the
 * shipped behaviour instead of overriding it outright.
 */
const RPCS: Record<Env['ALTANA_NETWORK'], readonly string[]> = {
  'bnb-testnet': [
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    'https://bsc-testnet-dataseed.bnbchain.org',
    'https://bsc-testnet.public.blastapi.io',
    BNB_TESTNET.publicRpcUrl,
  ],
  bnb: [
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-rpc.publicnode.com',
    'https://binance.llamarpc.com',
    BNB.publicRpcUrl,
  ],
};

/**
 * A read client on the first endpoint that answers, resolved once and reused.
 *
 * Lazily, because picking an endpoint costs a round trip and doing it per request would put
 * that on the critical path of every read. Cached as the promise rather than the result, so
 * concurrent callers during startup share one probe instead of racing several.
 */
export function createNetworkReader(
  network: ResolvedNetwork,
  logger: Logger,
): { client: () => Promise<PublicClient>; rpcUrl: () => Promise<string> } {
  let resolved: Promise<{ client: PublicClient; url: string }> | null = null;

  const resolve = async (): Promise<{ client: PublicClient; url: string }> => {
    for (const url of RPCS[network.name]) {
      try {
        const candidate = createPublicClient({
          chain: network.config.chain,
          transport: http(url),
        }) as PublicClient;
        await candidate.getBlockNumber();
        logger.debug({ url, network: network.name }, 'altana read endpoint selected');
        return { client: candidate, url };
      } catch {
        logger.debug({ url }, 'altana read endpoint unavailable, trying the next');
      }
    }

    /*
     * Cleared so a later request retries instead of being permanently poisoned by one
     * outage. Without this, a network blip during startup would disable hiring reads for the
     * lifetime of the process.
     */
    resolved = null;
    throw upstreamUnavailable(`no ${network.name} RPC endpoint answered`);
  };

  const get = (): Promise<{ client: PublicClient; url: string }> => (resolved ??= resolve());

  return {
    client: async () => (await get()).client,
    rpcUrl: async () => (await get()).url,
  };
}
