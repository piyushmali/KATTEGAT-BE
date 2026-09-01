import { keccak256, type Address, type Hex } from 'viem';
import type { Logger } from 'pino';
import { upstreamUnavailable } from '../../shared/errors.js';
import type { ResolvedNetwork } from './network.js';
import { createNetworkReader } from './network.js';

/**
 * Reading agent authority out of the public Altana Keystore.
 *
 * This is what makes the backend safe to be a bookkeeper. The browser grants a session with
 * the user's passkey and then tells us about it, and a claim from a browser is not evidence:
 * without checking, anyone could POST a fabricated session and the marketplace would display
 * a spend cap and an expiry for authority that never existed. Worse, it would show a
 * revoke button that does nothing.
 *
 * So every write to our sessions table is gated on a read of the Keystore, which is a public
 * on-chain registry that Altana describes as "owned by no one and readable by anyone". We are
 * not a trusted party in this flow and do not need to be.
 *
 * The registry is also why revocation can be believed. `isValidKey` goes false the moment the
 * user revokes, whether they did it through KATTEGAT, through another app, or through the
 * Altana MCP server in Claude. Our record follows the chain rather than the reverse.
 */

/**
 * Minimal Keystore surface.
 *
 * Two functions, hand-written rather than pulled from an ABI file, because these are the only
 * ones read here and the shapes came from watching the SDK call them: the signature appeared
 * in a live error trace as `isValidKey(address user, bytes32 keyId)`.
 */
const keystoreAbi = [
  {
    type: 'function',
    name: 'isValidKey',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface SessionClaim {
  /** The wallet the session acts on. */
  walletAddress: Address;
  /** The session key's public key, as returned by `grantSession`. */
  publicKey: Hex;
}

export interface KeystoreReader {
  /**
   * Whether this session key currently holds authority on this wallet, per the registry.
   *
   * False covers every way authority can be absent: never granted, expired, revoked, or
   * granted on a different chain. The caller does not need to tell those apart, because in
   * all four cases recording it as live authority would be wrong.
   */
  hasAuthority(claim: SessionClaim): Promise<boolean>;
  /** Native balance, used to decide whether a wallet needs gas sponsorship. */
  nativeBalance(address: Address): Promise<bigint>;
}

/**
 * The registry indexes keys by a hash, not by the raw public key.
 *
 * `keccak256` of the public key bytes, which is what the SDK's own error surfaced as `keyId`
 * alongside the public key it was derived from. Kept as a named function because getting this
 * wrong fails open in the worst direction: an unrecognised key hash reads as "no authority",
 * so a bug here rejects genuine sessions rather than accepting fake ones. That is the right
 * way round, and it is deliberate rather than lucky.
 */
export function toKeyId(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

export function createKeystoreReader(
  network: ResolvedNetwork,
  logger: Logger,
): KeystoreReader {
  const reader = createNetworkReader(network, logger);

  return {
    async hasAuthority({ walletAddress, publicKey }) {
      const client = await reader.client();

      try {
        return await client.readContract({
          address: network.config.keyStore,
          abi: keystoreAbi,
          functionName: 'isValidKey',
          args: [walletAddress, toKeyId(publicKey)],
        });
      } catch (error) {
        /*
         * Thrown rather than treated as "no authority".
         *
         * A read failure is our problem, not an answer about the user's session, and
         * conflating the two would let an RPC outage silently reject every genuine grant. The
         * caller surfaces this as an upstream failure the user can retry.
         */
        throw upstreamUnavailable('could not read agent authority from the Keystore', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async nativeBalance(address) {
      const client = await reader.client();

      try {
        return await client.getBalance({ address });
      } catch (error) {
        throw upstreamUnavailable('could not read the wallet balance', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
