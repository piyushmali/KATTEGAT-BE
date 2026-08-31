import { createPublicClient, http, type Hex } from 'viem';
import {
  BNB_TESTNET,
  createClient,
  signerFromPrivateKey,
  type NetworkConfig,
} from '@altananetwork/sdk';
import type { Logger } from 'pino';
import { upstreamUnavailable } from '../../shared/errors.js';

/**
 * Granting and revoking scoped agent authority through Altana.
 *
 * This is the "hire" in agent marketplace, and the shape of it is the product's central
 * safety claim: a user never hands an agent a wallet, they grant it a session bounded by a
 * spend ceiling, a call allowlist and an expiry, and they can take it back in one
 * transaction. Altana enforces all four in the account contract, so the limits hold whether
 * or not KATTEGAT is still running.
 *
 * WHAT IS REAL AND WHAT IS A SANDBOX
 *
 * Every step here happens on chain: the grant, the Keystore registration that makes the
 * authority third-party verifiable, and the revocation. Proven end to end by
 * `pnpm altana:smoke`, which also asserts that an out-of-scope call is refused and that a
 * revoked session cannot act.
 *
 * What is *not* real is whose money is at stake. The admin signer is a KATTEGAT-operated key
 * on BSC testnet, so a visitor granting a session is exercising the true mechanism against a
 * sandbox account rather than their own. That is a deliberate limit, not a shortcut we hope
 * nobody notices, and the UI says so plainly.
 *
 * The honest version needs the visitor's own wallet to be the admin signer. `@altananetwork/sdk`
 * 0.8.0 documents `signerFromInjected` for exactly that and does not export it, and the
 * private-key path is required for the EIP-7702 upgrade inside `createWallet`, so a browser
 * signer is a larger piece of work than wiring this up. When that lands, only the signer
 * changes: the grant, registration and revoke calls below stay as they are.
 *
 * ponytail: one process-wide admin signer, so every sandbox session is granted on the same
 * account and sessions cannot be attributed to individual visitors. Fine while this is a
 * labelled sandbox with no per-user funds; the upgrade path is a signer per connected wallet,
 * which is the same change the browser-signer work requires.
 */

/** Rolling windows Altana accepts for a spend cap. */
export const SPEND_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;

export type SpendPeriod = (typeof SPEND_PERIODS)[number];

export interface GrantAuthorityInput {
  /** Ceiling in wei. Enforced on chain, not by us. */
  spendLimitWei: bigint;
  spendPeriod: SpendPeriod;
  /** Unix seconds. The session stops working at this point with no further action. */
  expiryUnix: number;
  /**
   * Contract addresses the session may call.
   *
   * Empty grants no call restriction, which the SDK reads as "any target". Callers should
   * pass something: an unbounded allowlist is the one part of this model that does not
   * degrade safely.
   */
  allowedTargets: readonly `0x${string}`[];
}

export interface GrantedAuthority {
  publicKey: Hex;
  walletAddress: `0x${string}`;
  chainId: number;
  expiryUnix: number;
  /** Present when the relay surfaced a receipt. The grant is confirmed either way. */
  transactionHash: Hex | null;
  keystoreRegistered: boolean;
}

export interface SessionAuthority {
  /** True when a signer is configured. False turns the hire flow into an honest notice. */
  readonly enabled: boolean;
  readonly chainId: number;
  /** Block explorer base, so the UI can link a transaction without hardcoding a host. */
  readonly explorerUrl: string;
  grant(input: GrantAuthorityInput): Promise<GrantedAuthority>;
  revoke(publicKey: Hex): Promise<{ transactionHash: Hex | null }>;
}

/**
 * Read endpoints for testnet, tried in order.
 *
 * The SDK's packaged default answered a Cloudflare 520 during the first live run and failed
 * the Keystore check on a key that had already been granted on chain, so a flaky read
 * endpoint reported a failure about a session that existed. `NetworkConfig.publicRpcUrl`
 * documents itself as overridable; this is that override.
 */
const TESTNET_RPCS = [
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  'https://bsc-testnet-dataseed.bnbchain.org',
  'https://bsc-testnet.public.blastapi.io',
  BNB_TESTNET.publicRpcUrl,
] as const;

async function firstResponsiveRpc(logger: Logger): Promise<string> {
  for (const url of TESTNET_RPCS) {
    try {
      const probe = createPublicClient({ chain: BNB_TESTNET.chain, transport: http(url) });
      await probe.getBlockNumber();
      return url;
    } catch {
      logger.debug({ url }, 'testnet rpc unavailable, trying the next');
    }
  }

  throw upstreamUnavailable('no BSC testnet RPC endpoint answered');
}

export interface SessionAuthorityOptions {
  /** Throwaway testnet key from `AGENT_SESSION_PRIVATE_KEY`. Absent disables the feature. */
  privateKey: string | undefined;
  logger: Logger;
}

/**
 * A disabled authority, returned when no signer is configured.
 *
 * Deliberately explicit rather than a null the callers have to remember to check. A
 * marketplace deployed without a signer should say hiring is unavailable, not crash on the
 * first attempt or silently pretend a grant happened.
 */
function disabledAuthority(): SessionAuthority {
  const unavailable = (): never => {
    throw upstreamUnavailable('agent session authority is not configured on this deployment');
  };

  return {
    enabled: false,
    chainId: BNB_TESTNET.chainId,
    explorerUrl: BNB_TESTNET.explorer,
    grant: unavailable,
    revoke: unavailable,
  };
}

export function createSessionAuthority({
  privateKey,
  logger,
}: SessionAuthorityOptions): SessionAuthority {
  if (privateKey === undefined || !privateKey.startsWith('0x')) {
    logger.warn(
      'AGENT_SESSION_PRIVATE_KEY is not set; hiring will report itself unavailable rather than failing on use',
    );
    return disabledAuthority();
  }

  const admin = signerFromPrivateKey(privateKey as Hex);

  /*
   * Resolved once, lazily, and shared. Picking an RPC costs a round trip, and doing it per
   * request would put that on the critical path of every grant.
   */
  let network: Promise<NetworkConfig> | null = null;
  const resolveNetwork = (): Promise<NetworkConfig> => {
    network ??= firstResponsiveRpc(logger).then((publicRpcUrl) => ({
      ...BNB_TESTNET,
      publicRpcUrl,
    }));
    return network;
  };

  return {
    enabled: true,
    chainId: BNB_TESTNET.chainId,
    explorerUrl: BNB_TESTNET.explorer,

    async grant(input) {
      const config = await resolveNetwork();
      const client = createClient({ chains: [config] });

      try {
        const wallet = await client.createWallet({ signer: admin });

        const session = await client.grantSession({
          wallet,
          signer: admin,
          permissions: {
            spend: [{ limit: input.spendLimitWei, period: input.spendPeriod }],
            /*
             * Omitted entirely when no target was named. Passing an empty array would be a
             * grant of "no permitted calls", which is not the same as "no restriction" and
             * would produce a session that cannot do anything.
             */
            ...(input.allowedTargets.length > 0
              ? { calls: input.allowedTargets.map((to) => ({ to })) }
              : {}),
          },
          expiry: input.expiryUnix,
          // Registered in the Keystore, which is what makes the authority verifiable by
          // anyone rather than a claim in our database.
          register: true,
        });

        /*
         * Asked for again explicitly. `register: true` above should have done it, and this is
         * idempotent, so it costs nothing when the grant already succeeded and closes the
         * case where registration silently did not happen.
         */
        let keystoreRegistered = true;
        try {
          await client.registerSessionKey({ wallet, signer: admin, session });
        } catch (error) {
          // A session works without registration; it is just invisible to third parties. Not
          // worth failing a hire over, worth being honest about.
          keystoreRegistered = false;
          logger.warn({ err: error }, 'session granted but Keystore registration unconfirmed');
        }

        logger.info(
          { publicKey: session.publicKey, expiry: input.expiryUnix },
          'agent session granted',
        );

        return {
          publicKey: session.publicKey,
          walletAddress: wallet.address,
          chainId: config.chainId,
          expiryUnix: input.expiryUnix,
          transactionHash: session.transactionHash ?? null,
          keystoreRegistered,
        };
      } catch (error) {
        throw upstreamUnavailable('granting agent authority failed', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async revoke(publicKey) {
      const config = await resolveNetwork();
      const client = createClient({ chains: [config] });

      try {
        const wallet = await client.createWallet({ signer: admin });
        /*
         * Revocable by public key alone, without the original Session object. That is what
         * lets revocation work from a stored row after a restart, which is the only way the
         * promise means anything: authority you can only withdraw while the granting process
         * is still alive is not revocable.
         */
        const result = await client.revokeSession({ wallet, signer: admin, session: publicKey });

        logger.info({ publicKey, status: result.status }, 'agent session revoked');
        return { transactionHash: result.transactionHash ?? null };
      } catch (error) {
        throw upstreamUnavailable('revoking agent authority failed', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
