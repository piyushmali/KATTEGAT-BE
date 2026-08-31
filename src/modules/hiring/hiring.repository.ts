import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import {
  agentSessions,
  agents,
  type AgentSessionRow,
  type NewAgentSessionRow,
} from '../../infrastructure/database/schema.js';

/**
 * Persistence for granted authority.
 *
 * A local index of what is on chain, never the authority itself. The Altana account contract
 * enforces the limits and the Keystore records the grant; this table exists so one page load
 * does not have to read a chain to list what a user granted.
 *
 * Which means the honest failure mode is this table being *behind*, not this table being
 * wrong in a way that matters. A session missing here is still enforced on chain; a session
 * here that was revoked out-of-band shows as active until we look again. Both are recoverable.
 * Neither would be if this were the source of truth.
 */

export interface HiringRepository {
  /** Null when the agent is not indexed, which is a 404 rather than a failed grant. */
  agentExists(agentId: string): Promise<boolean>;
  record(session: NewAgentSessionRow): Promise<AgentSessionRow>;
  listForAgent(agentId: string): Promise<AgentSessionRow[]>;
  findByPublicKey(publicKey: string): Promise<AgentSessionRow | null>;
  markRevoked(publicKey: string, txHash: string | null): Promise<AgentSessionRow | null>;
  /** Live sessions across every agent, for the "what have I granted" view. */
  listActive(limit: number): Promise<AgentSessionRow[]>;
}

export function createHiringRepository(db: Database): HiringRepository {
  return {
    async agentExists(agentId) {
      const [row] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      return row !== undefined;
    },

    async record(session) {
      const [row] = await db.insert(agentSessions).values(session).returning();
      if (!row) throw new Error('failed to record the granted session');
      return row;
    },

    async listForAgent(agentId) {
      return db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.agentId, agentId))
        // Newest first: the session a user just granted is the one they came to look at.
        .orderBy(desc(agentSessions.grantedAt));
    },

    async findByPublicKey(publicKey) {
      const [row] = await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.publicKey, publicKey))
        .limit(1);
      return row ?? null;
    },

    async markRevoked(publicKey, txHash) {
      const [row] = await db
        .update(agentSessions)
        .set({ revokedAt: new Date(), revokedTxHash: txHash })
        /*
         * Only when not already revoked, so a repeated request cannot overwrite the first
         * revocation's timestamp and transaction with a later one. The chain already treats
         * the second revoke as a no-op; this keeps our record of *when* authority ended
         * accurate, which is the part an audit would care about.
         */
        .where(and(eq(agentSessions.publicKey, publicKey), isNull(agentSessions.revokedAt)))
        .returning();
      return row ?? null;
    },

    async listActive(limit) {
      return db
        .select()
        .from(agentSessions)
        .where(isNull(agentSessions.revokedAt))
        .orderBy(desc(agentSessions.grantedAt))
        .limit(limit);
    },
  };
}
