import type { Logger } from 'pino';
import type { Address, Hex } from 'viem';
import { badRequest, notFound } from '../../shared/errors.js';
import type { GasSponsor } from '../../integrations/altana/gas-sponsor.js';
import type { KeystoreReader } from '../../integrations/altana/keystore.js';
import type { ResolvedNetwork } from '../../integrations/altana/network.js';
import type { AgentSessionRow } from '../../infrastructure/database/schema.js';
import type { HiringRepository } from './hiring.repository.js';
import type { AgentSessionResponse, RecordSessionBody } from './hiring.schema.js';

/**
 * Hiring: recording authority the user granted, and following it as it changes.
 *
 * The backend does not grant and cannot revoke. The user's passkey holds admin authority on
 * their Altana wallet, the browser performs both operations, and this service verifies the
 * result against the public Keystore and keeps a local index so a page load does not have to
 * decode a registry.
 *
 * WHY VERIFICATION IS THE WHOLE DESIGN
 *
 * A request here is a claim from a browser. Trusting it would let anyone record a fabricated
 * session, and the marketplace would then display a spend cap, an expiry and a revoke button
 * for authority that never existed. So nothing is written until `hasAuthority` confirms the
 * Keystore agrees, and `status` is read from the chain on every list rather than from our own
 * `revoked_at`.
 *
 * That last part matters more than it looks. A user can revoke through another app, or through
 * the Altana MCP server in Claude, and never touch KATTEGAT. Deriving status from our column
 * would show that session as live indefinitely.
 */

export interface HiringService {
  recordSession(agentId: string, body: RecordSessionBody): Promise<HiringResult>;
  listForAgent(agentId: string): Promise<HiringList>;
  /** Confirms a revocation the browser performed. Never performs one. */
  confirmRevoked(publicKey: string): Promise<AgentSessionResponse>;
  sponsorGas(walletAddress: string): Promise<{
    transaction_hash: string | null;
    amount_wei: string | null;
    sponsor_address: string | null;
    sponsored: boolean;
  }>;
}

interface HiringContext {
  enabled: boolean;
  chain_id: number;
  network: string;
  is_mainnet: boolean;
  native_symbol: string;
  explorer_url: string;
  keystore_address: string;
  gas_sponsored: boolean;
}

interface HiringResult {
  data: AgentSessionResponse;
  meta: HiringContext;
}

interface HiringList {
  data: AgentSessionResponse[];
  meta: HiringContext;
}

export interface HiringServiceDeps {
  repository: HiringRepository;
  keystore: KeystoreReader;
  sponsor: GasSponsor;
  network: ResolvedNetwork;
  logger: Logger;
}

const iso = (value: Date): string => value.toISOString();

export function createHiringService({
  repository,
  keystore,
  sponsor,
  network,
  logger,
}: HiringServiceDeps): HiringService {
  const context = (): HiringContext => ({
    enabled: true,
    chain_id: network.config.chainId,
    network: network.name,
    is_mainnet: network.isMainnet,
    native_symbol: network.nativeSymbol,
    explorer_url: network.config.explorer,
    keystore_address: network.config.keyStore,
    gas_sponsored: sponsor.enabled,
  });

  /**
   * Status from the registry, with our columns as the fallback.
   *
   * Expiry is checked first because it needs no network call and is the common way authority
   * ends. Beyond that the Keystore decides, so a revocation performed anywhere is reflected
   * here.
   */
  const statusOf = async (row: AgentSessionRow): Promise<AgentSessionResponse['status']> => {
    if (row.revokedAt !== null) return 'revoked';
    if (row.expiresAt.getTime() <= Date.now()) return 'expired';

    const live = await keystore.hasAuthority({
      walletAddress: row.walletAddress as Address,
      publicKey: row.publicKey as Hex,
    });

    /*
     * Recorded when the chain disagrees with us, so the next read is cheap and the local index
     * converges on the truth instead of asking again forever.
     */
    if (!live) {
      await repository.markRevoked(row.publicKey, null);
      logger.info(
        { publicKey: row.publicKey },
        'session no longer authorised on chain; recorded as revoked',
      );
      return 'revoked';
    }

    return 'active';
  };

  const toWire = async (row: AgentSessionRow): Promise<AgentSessionResponse> => ({
    public_key: row.publicKey,
    agent_id: row.agentId,
    wallet_address: row.walletAddress,
    spend_limit_wei: row.spendLimitWei,
    spend_period: row.spendPeriod,
    allowed_calls: row.allowedCalls,
    expires_at: iso(row.expiresAt),
    granted_at: iso(row.grantedAt),
    granted_tx_hash: row.grantedTxHash,
    revoked_at: row.revokedAt === null ? null : iso(row.revokedAt),
    revoked_tx_hash: row.revokedTxHash,
    chain_id: row.chainId,
    status: await statusOf(row),
  });

  return {
    async recordSession(agentId, body) {
      if (!(await repository.agentExists(agentId))) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const expiresAt = new Date(body.expires_at_unix * 1000);
      if (expiresAt.getTime() <= Date.now()) {
        throw badRequest('That session has already expired, so there is nothing to record.');
      }

      /*
       * The gate. Everything above this line is shape validation; this is the only check that
       * establishes the session is real.
       */
      const authorised = await keystore.hasAuthority({
        walletAddress: body.wallet_address as Address,
        publicKey: body.public_key as Hex,
      });

      if (!authorised) {
        throw badRequest(
          'The Keystore does not show this session key as authorised on that wallet. Nothing was recorded.',
        );
      }

      const row = await repository.record({
        publicKey: body.public_key,
        agentId,
        walletAddress: body.wallet_address,
        spendLimitWei: body.spend_limit_wei,
        spendPeriod: body.spend_period,
        allowedCalls: body.allowed_targets,
        expiresAt,
        grantedTxHash: body.granted_tx_hash ?? null,
        chainId: network.config.chainId,
      });

      logger.info({ agentId, publicKey: row.publicKey }, 'agent hired');
      return { data: await toWire(row), meta: context() };
    },

    async listForAgent(agentId) {
      if (!(await repository.agentExists(agentId))) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const rows = await repository.listForAgent(agentId);
      return {
        data: await Promise.all(rows.map(toWire)),
        meta: context(),
      };
    },

    async confirmRevoked(publicKey) {
      const existing = await repository.findByPublicKey(publicKey);
      if (existing === null) {
        throw notFound('No granted session with that key is on record.');
      }

      /*
       * Verified, not taken on trust. A client claiming a revocation it did not perform would
       * otherwise turn off the revoke button while the agent still had authority, which is the
       * most dangerous thing this endpoint could do.
       */
      const stillAuthorised = await keystore.hasAuthority({
        walletAddress: existing.walletAddress as Address,
        publicKey: existing.publicKey as Hex,
      });

      if (stillAuthorised) {
        throw badRequest(
          'The Keystore still shows this session as authorised. The revocation may not have confirmed yet.',
        );
      }

      const row = (await repository.markRevoked(publicKey, null)) ?? existing;
      logger.info({ publicKey }, 'revocation confirmed on chain');
      return toWire(row);
    },

    async sponsorGas(walletAddress) {
      if (!sponsor.enabled) {
        return {
          transaction_hash: null,
          amount_wei: null,
          sponsor_address: null,
          sponsored: false,
        };
      }

      const result = await sponsor.fund(walletAddress as Address);

      return {
        transaction_hash: result?.transactionHash ?? null,
        amount_wei: result?.amountWei ?? null,
        sponsor_address: sponsor.address,
        // True when sponsorship is available, whether or not this call needed to send anything.
        sponsored: true,
      };
    },
  };
}
