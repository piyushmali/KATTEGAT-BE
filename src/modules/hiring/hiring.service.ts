import type { Logger } from 'pino';
import type { Address, Hex } from 'viem';
import { badRequest, notFound } from '../../shared/errors.js';
import type { GasSponsor } from '../../integrations/altana/gas-sponsor.js';
import { REGISTRY_CHAIN } from '../../integrations/bsc-client.js';
import {
  JOB_STATUS_INDEX,
  PAYMENT_TOKEN,
  type Erc8183JobReader,
} from '../../integrations/erc8183/job-reader.js';
import type { JobRepository } from '../jobs/job.repository.js';
import type { KeystoreReader } from '../../integrations/altana/keystore.js';
import type { ResolvedNetwork } from '../../integrations/altana/network.js';
import type { AgentSessionRow } from '../../infrastructure/database/schema.js';
import type { HiringRepository } from './hiring.repository.js';
import type {
  AgentSessionResponse,
  RecordJobBody,
  RecordedJobResponse,
  RecordSessionBody,
} from './hiring.schema.js';

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
  /** Verifies and records an escrowed job the browser funded. Never funds one. */
  recordJob(agentId: string, body: RecordJobBody): Promise<RecordJobResult>;
  sponsorGas(walletAddress: string): Promise<{
    transaction_hash: string | null;
    amount_wei: string | null;
    sponsor_address: string | null;
    sponsored: boolean;
  }>;
}

interface EscrowContext {
  available: boolean;
  commerce_address: string;
  router_address: string;
  policy_address: string;
  payment_token_address: string;
  payment_token_symbol: string;
  payment_token_decimals: number;
  dispute_window_seconds: number;
  allowed_targets: string[];
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
  escrow: EscrowContext;
}

interface HiringResult {
  data: AgentSessionResponse;
  meta: HiringContext;
}

interface HiringList {
  data: AgentSessionResponse[];
  meta: HiringContext;
}

interface RecordJobResult {
  data: RecordedJobResponse;
  meta: HiringContext;
}

export interface HiringServiceDeps {
  repository: HiringRepository;
  keystore: KeystoreReader;
  sponsor: GasSponsor;
  network: ResolvedNetwork;
  /**
   * ERC-8183 on the session's chain, not on the registry's.
   *
   * A hire lands wherever the user's session lives, so verification has to read that kernel. In
   * production it is the same chain the catalogue was indexed from; on testnet it is not, which is
   * what `counts_as_evidence` on the response is about.
   */
  escrow: Erc8183JobReader;
  /** Writes the verified job. The same table the indexer writes, and the same shape. */
  jobs: Pick<JobRepository, 'save' | 'reattribute'>;
  logger: Logger;
}

const iso = (value: Date): string => value.toISOString();

export function createHiringService({
  repository,
  keystore,
  sponsor,
  network,
  escrow,
  jobs,
  logger,
}: HiringServiceDeps): HiringService {
  const escrowContext = async (): Promise<EscrowContext> => {
    const policy = await escrow.escrowPolicy();

    return {
      available: policy.usable,
      commerce_address: escrow.addresses.commerce,
      router_address: escrow.addresses.router,
      policy_address: policy.address,
      payment_token_address: escrow.addresses.paymentToken,
      payment_token_symbol: PAYMENT_TOKEN.symbol,
      payment_token_decimals: PAYMENT_TOKEN.decimals,
      dispute_window_seconds: policy.disputeWindowSeconds,
      /*
       * Exactly the contracts a hire touches, and no more. The browser grants a session over this
       * list, so anything missing here breaks the batch partway and anything extra widens what the
       * key can do beyond commissioning work.
       */
      allowed_targets: [
        escrow.addresses.commerce,
        escrow.addresses.router,
        escrow.addresses.paymentToken,
      ],
    };
  };

  const context = async (): Promise<HiringContext> => ({
    enabled: true,
    chain_id: network.config.chainId,
    network: network.name,
    is_mainnet: network.isMainnet,
    native_symbol: network.nativeSymbol,
    explorer_url: network.config.explorer,
    keystore_address: network.config.keyStore,
    gas_sponsored: sponsor.enabled,
    escrow: await escrowContext(),
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
      return { data: await toWire(row), meta: await context() };
    },

    async listForAgent(agentId) {
      if (!(await repository.agentExists(agentId))) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const rows = await repository.listForAgent(agentId);
      return {
        data: await Promise.all(rows.map(toWire)),
        meta: await context(),
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

    /**
     * Records an escrowed job the browser funded.
     *
     * The same shape of endpoint as `recordSession`, and for the same reason: the backend holds no
     * key, so it cannot commission work. The user's session signed the batch; this verifies the
     * result against the kernel and writes it down.
     *
     * Three checks, and each one exists because skipping it would let a request state something
     * untrue about an agent.
     */
    async recordJob(agentId, body) {
      const agent = await repository.findAgent(agentId);
      if (agent === null) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const [job] = await escrow.readJobs([body.job_id]);

      /*
       * 1. The job exists. Not a formality: reading an unminted id returns a zero-filled tuple
       *    rather than reverting, so `readJobs` drops anything whose id does not come back
       *    matching. Without that, any id at all would look like an open job with no budget.
       */
      if (job === undefined) {
        throw badRequest(`Job ${String(body.job_id)} does not exist on chain ${String(escrow.chainId)}.`);
      }

      /*
       * 2. The job names this agent. The kernel identifies a provider by address, so this is what
       *    stops a real job for one agent being recorded against another. Compared to the agent's
       *    own wallet address, which is also what the indexer attributes by.
       */
      if (agent.walletAddress === null) {
        throw badRequest('That agent publishes no wallet address, so a job cannot be tied to it.');
      }
      if (job.providerAddress !== agent.walletAddress.toLowerCase()) {
        throw badRequest(
          `Job ${String(body.job_id)} names ${job.providerAddress} as its provider, which is not this agent.`,
        );
      }

      /*
       * 3. The escrow was funded. An OPEN job costs nothing to create and needs no agreement from
       *    the agent, so recording one would let anyone add to an agent's history for free.
       */
      if (job.status <= JOB_STATUS_INDEX.open) {
        throw badRequest(
          'That job has not been funded yet, so there is nothing escrowed to record. Fund it and try again.',
        );
      }

      await jobs.save([job]);
      const relinked = await jobs.reattribute();

      logger.info(
        { agentId, jobId: job.jobId, chainId: job.chainId, status: job.statusName, relinked },
        'escrowed job recorded',
      );

      return {
        data: {
          job_id: job.jobId,
          chain_id: job.chainId,
          status: job.statusName,
          client_address: job.clientAddress,
          provider_address: job.providerAddress,
          budget_raw: job.budgetRaw,
          description: job.description,
          expired_at: iso(job.expiredAt),
          /*
           * Only when the hire happened on the chain the catalogue was indexed from. On testnet it
           * did not, and the agent is not registered on that kernel, so presenting the job as part
           * of its record would be manufacturing one.
           */
          counts_as_evidence: job.chainId === REGISTRY_CHAIN.id,
        },
        meta: await context(),
      };
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
