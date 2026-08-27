import { eq } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import { agentReputation, agents } from '../../infrastructure/database/schema.js';

/**
 * Persistence for the reputation domain.
 *
 * Reads the cached snapshot ingestion wrote, and confirms an agent is indexed at
 * all. Kept separate from the agents repository so a live reputation read does
 * not have to load a full agent aggregate to answer one question.
 */

export interface StoredReputation {
  feedbackCount: number;
  clientCount: number;
  summaryValue: number | null;
  summaryDecimals: number | null;
  computedAt: Date;
}

export interface ReputationRepository {
  /** Numeric on-chain agent id for a composite id, or null when not indexed. */
  findAgentNumericId(id: string): Promise<number | null>;
  findSnapshot(id: string): Promise<StoredReputation | null>;
  saveSnapshot(id: string, snapshot: StoredReputation & { source: string }): Promise<void>;
}

export function createReputationRepository(db: Database): ReputationRepository {
  return {
    async findAgentNumericId(id: string): Promise<number | null> {
      const [row] = await db
        .select({ agentId: agents.agentId })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1);
      return row?.agentId ?? null;
    },

    async findSnapshot(id: string): Promise<StoredReputation | null> {
      const [row] = await db
        .select()
        .from(agentReputation)
        .where(eq(agentReputation.agentId, id))
        .limit(1);

      if (!row) return null;

      return {
        feedbackCount: row.feedbackCount,
        clientCount: row.clientCount,
        summaryValue: row.summaryValue,
        summaryDecimals: row.summaryDecimals,
        computedAt: row.computedAt,
      };
    },

    /** Refreshes the cache after a successful live read, so the next miss is cheaper. */
    async saveSnapshot(id: string, snapshot: StoredReputation & { source: string }): Promise<void> {
      const values = {
        agentId: id,
        feedbackCount: snapshot.feedbackCount,
        clientCount: snapshot.clientCount,
        summaryValue: snapshot.summaryValue,
        summaryDecimals: snapshot.summaryDecimals,
        source: snapshot.source,
        computedAt: snapshot.computedAt,
      };

      await db
        .insert(agentReputation)
        .values(values)
        .onConflictDoUpdate({ target: agentReputation.agentId, set: values });
    },
  };
}
