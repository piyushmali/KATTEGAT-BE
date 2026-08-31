import type { Logger } from 'pino';
import { conflict, notFound } from '../../shared/errors.js';
import type { SessionAuthority } from '../../integrations/altana/session-authority.js';
import type { AgentSessionRow } from '../../infrastructure/database/schema.js';
import type { HiringRepository } from './hiring.repository.js';
import type {
  AgentSessionResponse,
  GrantSessionBody,
  grantSessionResponseSchema,
  listSessionsResponseSchema,
} from './hiring.schema.js';
import type { z } from 'zod';

/**
 * Hiring an agent: granting it bounded authority, and taking that authority back.
 *
 * The order of operations is the whole design. Authority is granted on chain *first*, and only
 * recorded here once the chain has accepted it. The reverse would let this table claim a hire
 * that never happened, which is the one failure this module must not have: a user reading
 * "active, 0.01 tBNB/day" about a session that does not exist has been told something false
 * about their own money.
 *
 * Revocation runs the same way round, and it is the more important of the two. It revokes on
 * chain, then records it. If the chain call fails the row stays active, which is accurate: the
 * agent can still act, and telling the user otherwise would be the dangerous lie.
 */

export interface HiringService {
  grant(agentId: string, body: GrantSessionBody): Promise<z.infer<typeof grantSessionResponseSchema>>;
  listForAgent(agentId: string): Promise<z.infer<typeof listSessionsResponseSchema>>;
  revoke(publicKey: string): Promise<AgentSessionResponse>;
}

export interface HiringServiceDeps {
  repository: HiringRepository;
  authority: SessionAuthority;
  logger: Logger;
}

const iso = (value: Date): string => value.toISOString();

/**
 * Authority ends two different ways and the UI has to tell them apart.
 *
 * Revoked means someone took it back; expired means nobody had to. Both mean the agent cannot
 * act, so collapsing them into one flag would be tempting and would lose the more interesting
 * half: an expired session is a session that ran its course, a revoked one is a decision.
 */
function toStatus(row: AgentSessionRow): AgentSessionResponse['status'] {
  if (row.revokedAt !== null) return 'revoked';
  return row.expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
}

function toWire(row: AgentSessionRow): AgentSessionResponse {
  return {
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
    status: toStatus(row),
  };
}

export function createHiringService({
  repository,
  authority,
  logger,
}: HiringServiceDeps): HiringService {
  return {
    async grant(agentId, body) {
      if (!(await repository.agentExists(agentId))) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const expiryUnix = Math.floor(Date.now() / 1000) + body.duration_minutes * 60;

      /*
       * Chain first. Nothing is written here until the account contract has accepted the
       * grant, so this table cannot describe authority that does not exist.
       */
      const granted = await authority.grant({
        spendLimitWei: BigInt(body.spend_limit_wei),
        spendPeriod: body.spend_period,
        expiryUnix,
        allowedTargets: body.allowed_targets as `0x${string}`[],
      });

      const row = await repository.record({
        publicKey: granted.publicKey,
        agentId,
        walletAddress: granted.walletAddress,
        spendLimitWei: body.spend_limit_wei,
        spendPeriod: body.spend_period,
        allowedCalls: body.allowed_targets,
        expiresAt: new Date(granted.expiryUnix * 1000),
        grantedTxHash: granted.transactionHash,
        chainId: granted.chainId,
      });

      logger.info({ agentId, publicKey: granted.publicKey }, 'agent hired');

      return {
        data: toWire(row),
        meta: {
          keystore_registered: granted.keystoreRegistered,
          explorer_url: authority.explorerUrl,
        },
      };
    },

    async listForAgent(agentId) {
      if (!(await repository.agentExists(agentId))) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const rows = await repository.listForAgent(agentId);

      return {
        data: rows.map(toWire),
        meta: {
          enabled: authority.enabled,
          chain_id: authority.chainId,
          explorer_url: authority.explorerUrl,
          /*
           * Always true while the admin signer is a KATTEGAT key rather than the visitor's
           * wallet. Returned rather than left to the client to know, so the disclosure cannot
           * drift out of sync with what the backend is actually doing.
           */
          sandbox: authority.enabled,
        },
      };
    },

    async revoke(publicKey) {
      const existing = await repository.findByPublicKey(publicKey);
      if (existing === null) {
        throw notFound('No granted session with that key is on record.');
      }
      if (existing.revokedAt !== null) {
        // Idempotent on chain, but worth saying: a second revoke is a no-op, not a failure,
        // and reporting success would imply this call did something.
        throw conflict('That session has already been revoked.');
      }

      /*
       * Chain first, again, and here it matters more. If this throws, the row stays active,
       * which is the truth: the agent can still act. Marking it revoked on a failed call would
       * tell the user they are safe when they are not.
       */
      const { transactionHash } = await authority.revoke(publicKey as `0x${string}`);

      const row = await repository.markRevoked(publicKey, transactionHash);
      if (row === null) {
        // Lost a race with another revoke. The chain state is what we wanted either way.
        const latest = await repository.findByPublicKey(publicKey);
        if (latest === null) throw notFound('No granted session with that key is on record.');
        return toWire(latest);
      }

      return toWire(row);
    },
  };
}
