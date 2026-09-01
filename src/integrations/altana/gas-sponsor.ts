import { createWalletClient, formatEther, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from 'pino';
import { badRequest, upstreamUnavailable } from '../../shared/errors.js';
import type { KeystoreReader } from './keystore.js';
import type { ResolvedNetwork } from './network.js';
import { createNetworkReader } from './network.js';

/**
 * Topping up a user's wallet with enough native gas to hire an agent.
 *
 * The only key the backend holds, and it deliberately holds no authority over anyone's
 * account. It can send native tokens and nothing else: it cannot grant a session, cannot
 * revoke one, and cannot move a user's funds, because authority on an Altana wallet belongs
 * to the passkey in the user's device.
 *
 * WHY SPONSOR AT ALL
 *
 * Measured on the transactions this product actually produces, a full grant, act and revoke
 * lifecycle costs 962,143 gas: about 0.0000481 BNB, or three US cents at BNB $600. Asking
 * someone to go and fund a wallet before they have seen the product work, for three cents, is
 * the largest avoidable drop-off in the flow. So the first grant is on us and the agent's own
 * actions are on the user, who is spending their own money by then anyway.
 *
 * WHY IT IS BOUNDED
 *
 * An unbounded faucet endpoint is a drain: one loop empties the key. Two limits, both
 * enforced here rather than trusted to the caller. A fixed amount per request, and a refusal
 * when the address already holds enough to transact, which also makes repeat calls a no-op
 * instead of a top-up.
 *
 * ponytail: rate limiting is per-address balance, not per-IP, so a determined caller can
 * still drain the key one fresh address at a time. Ceiling is the sponsor balance, which is
 * why it holds a small float rather than a treasury. Upgrade path when this matters is a
 * per-session-per-day quota keyed on the granted session, which requires the session to exist
 * before funding and therefore a different order of operations.
 */

export interface GasSponsor {
  /** False when no key is configured. Hiring still works; the user funds their own gas. */
  readonly enabled: boolean;
  /** Address funds come from, so the UI can show where a top-up originated. */
  readonly address: Address | null;
  /**
   * Tops up `recipient` if it is below the ceiling.
   *
   * Returns null when no funding was needed, which is a success rather than a failure: a
   * wallet that already has gas does not need ours.
   */
  fund(recipient: Address): Promise<{ transactionHash: Hex; amountWei: string } | null>;
}

export interface GasSponsorOptions {
  network: ResolvedNetwork;
  keystore: KeystoreReader;
  privateKey: string;
  /** Sent per request. See AGENT_GAS_SPONSOR_AMOUNT_WEI. */
  amountWei: string;
  /** Refuse to fund an address already holding this much. */
  maxBalanceWei: string;
  logger: Logger;
}

export function createGasSponsor({
  network,
  keystore,
  privateKey,
  amountWei,
  maxBalanceWei,
  logger,
}: GasSponsorOptions): GasSponsor {
  if (privateKey === '') {
    logger.info(
      'AGENT_GAS_SPONSOR_PRIVATE_KEY is not set; users will fund their own gas and hiring still works',
    );
    return {
      enabled: false,
      address: null,
      fund: () => Promise.resolve(null),
    };
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const reader = createNetworkReader(network, logger);
  const amount = BigInt(amountWei);
  const ceiling = BigInt(maxBalanceWei);

  logger.info(
    { sponsor: account.address, network: network.name, amount: formatEther(amount) },
    'gas sponsorship enabled',
  );

  return {
    enabled: true,
    address: account.address,

    async fund(recipient) {
      /*
       * Checked before spending anything. This is both the rate limit and the reason a repeat
       * request is harmless: an address that can already pay for its own transactions is
       * refused rather than topped up again.
       */
      const balance = await keystore.nativeBalance(recipient);
      if (balance >= ceiling) {
        logger.debug({ recipient, balance: formatEther(balance) }, 'wallet already funded');
        return null;
      }

      const sponsorBalance = await keystore.nativeBalance(account.address);
      if (sponsorBalance < amount) {
        /*
         * A user-facing message, because this is the one failure here they can do something
         * about: the alternative is funding their own wallet, which still works.
         */
        throw badRequest(
          'Gas sponsorship is temporarily unavailable. You can still hire by funding your own wallet.',
        );
      }

      const rpcUrl = await reader.rpcUrl();
      const wallet = createWalletClient({
        account,
        chain: network.config.chain,
        transport: http(rpcUrl),
      });

      try {
        const transactionHash = await wallet.sendTransaction({ to: recipient, value: amount });
        logger.info(
          { recipient, amount: formatEther(amount), transactionHash },
          'sponsored wallet gas',
        );
        return { transactionHash, amountWei: amount.toString() };
      } catch (error) {
        throw upstreamUnavailable('funding the wallet failed', {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
