import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import {
  agentCategories,
  agentReputation,
  agents,
  type NewAgentRow,
} from '../../infrastructure/database/schema.js';
import type {
  AgentCategory,
  AgentCategoryAssignment,
  AgentReputation,
  AgentSummary,
  ProtocolTag,
} from './agent.types.js';
import {
  agentDisplayName,
  blankToNull,
  safeImageUrl,
  toAgentEndpoints,
  toDeclaredBoolean,
  toTrustModels,
} from './agent.types.js';
import { decodeScore } from '../reputation/score.js';

/**
 * All SQL for the agents domain lives here.
 *
 * Services compose behaviour; this file owns persistence. Keeping the boundary
 * strict is what lets the ingestion pipeline and the API share exactly one
 * definition of how an agent is written and read.
 */

export type AgentSortField = 'registered_at' | 'reputation' | 'name' | 'feedback';

export interface ListAgentsFilters {
  category?: AgentCategory;
  protocolTag?: ProtocolTag;
  /** Free-text match over name and description. */
  query?: string;
  /** Only agents whose registration file resolved. */
  resolvedOnly?: boolean;
  /** Minimum classification confidence, applied with `category`. */
  minConfidence?: number;
  traits?: string[];
}

export interface ListAgentsOptions {
  filters: ListAgentsFilters;
  sort: AgentSortField;
  direction: 'asc' | 'desc';
  page: number;
  perPage: number;
}

export interface ListAgentsResult {
  agents: AgentSummary[];
  total: number;
}

export interface AgentWritePayload {
  agent: NewAgentRow;
  categories: AgentCategoryAssignment[];
  reputation: {
    feedbackCount: number;
    clientCount: number;
    summaryValue: number | null;
    summaryDecimals: number | null;
    source: string;
  } | null;
}

/**
 * An agent recorded from chain whose registration file has not been retrieved yet.
 *
 * Carries the whole persisted row rather than just the URI, because resolving metadata
 * rewrites the agent through the same upsert path as discovery — sharing one write path
 * is what stops the two from drifting on normalisation or classification.
 */
export interface PendingMetadataAgent {
  id: string;
  chainId: number;
  agentId: number;
  ownerAddress: string;
  walletAddress: string | null;
  agentUri: string;
  registeredAtBlock: number | null;
  registeredAt: Date | null;
  source: string;
}

export interface AgentRepository {
  list(options: ListAgentsOptions): Promise<ListAgentsResult>;
  findById(id: string): Promise<AgentSummary | null>;
  upsertMany(payloads: AgentWritePayload[]): Promise<number>;
  /**
   * Agents awaiting a registration-file fetch, least-attempted first.
   *
   * Fewest attempts first so a pass cannot spend itself re-fetching URIs that have
   * already refused it many times. Newest id first within an attempt count because that
   * is the order `/discover` shows by default, so the agents a visitor sees first are the
   * ones that get a description first.
   */
  findPendingMetadata(limit: number): Promise<PendingMetadataAgent[]>;
  /** How many agents still have no resolved registration file. */
  countPendingMetadata(): Promise<number>;
  /**
   * Records that a fetch was attempted and did not produce a document.
   *
   * Separate from `upsertMany` because nothing about the agent changed: this only moves
   * the row further back in the retry queue. Returning it to the pass untouched, as an
   * earlier version did, meant the next pass selected the same dead rows and the backlog
   * could not drain.
   */
  recordMetadataFailures(ids: string[], attemptedAt: Date): Promise<void>;
  /**
   * Indexed agent ids above `afterAgentId`, ascending.
   *
   * Drives the reputation sweep. Reading ids out of our own table rather than counting up
   * from a cursor means the sweep skips nothing and wastes nothing: the registry has gaps,
   * and asking the chain about an id we have not indexed spends a call to learn nothing
   * while risking a foreign-key failure on the write.
   */
  findAgentIdsAfter(
    afterAgentId: number,
    limit: number,
  ): Promise<{ id: string; agentId: number }[]>;
  /**
   * Writes reputation snapshots for many agents in one statement.
   *
   * Distinct from `upsertMany`, which needs a whole agent payload. A sweep has read one
   * thing about thousands of agents and changed nothing else about them.
   */
  saveReputationSnapshots(
    snapshots: { id: string; reputation: AgentReputation }[],
  ): Promise<number>;
}

/* -------------------------------------------------------------------------- */

type AgentRowShape = typeof agents.$inferSelect;
type ReputationRowShape = typeof agentReputation.$inferSelect;

function toSummary(
  row: AgentRowShape,
  reputationRow: ReputationRowShape | null,
  categoryRows: (typeof agentCategories.$inferSelect)[],
): AgentSummary {
  const summaryValue = reputationRow?.summaryValue ?? null;
  const summaryDecimals = reputationRow?.summaryDecimals ?? null;

  /*
   * Read out of the stored registration file rather than kept in their own columns.
   * These fields were already being persisted inside `raw_metadata`, so surfacing them
   * needs no migration and no re-ingestion: every agent whose metadata has already
   * resolved gains its endpoints the moment this ships.
   */
  const metadata = row.rawMetadata as Record<string, unknown> | null;

  return {
    identity: {
      id: row.id,
      chainId: row.chainId,
      agentId: row.agentId,
      ownerAddress: row.ownerAddress,
      walletAddress: row.walletAddress,
      agentUri: row.agentUri,
      registeredAtBlock: row.registeredAtBlock,
      registeredAt: row.registeredAt,
    },
    profile: {
      /*
       * Normalised on read, not just on write, so the 529 rows already holding a blank
       * name or description are fixed without a migration or a re-fetch. The column keeps
       * whatever the document said, which is the same principle as `raw_metadata`.
       */
      name: agentDisplayName(row.name, row.agentId),
      description: blankToNull(row.description),
      capabilities: row.capabilities,
      protocolTag: row.protocolTag as ProtocolTag,
      traitTags: row.traitTags,
      imageUrl: safeImageUrl(metadata?.image),
      endpoints: toAgentEndpoints(metadata?.services, {
        agentId: row.agentId,
        walletAddress: row.walletAddress,
      }),
      trustModels: toTrustModels(metadata?.supportedTrust),
      x402Support: toDeclaredBoolean(metadata?.x402Support),
      declaredActive: toDeclaredBoolean(metadata?.active),
      metadataResolvedAt: row.metadataResolvedAt,
    },
    categories: categoryRows
      .map((categoryRow) => ({
        category: categoryRow.category as AgentCategory,
        confidence: categoryRow.confidence,
        isPrimary: categoryRow.isPrimary,
        signals: categoryRow.signals,
        classifierVersion: categoryRow.classifierVersion,
      }))
      // Primary first, then strongest confidence — stable ordering for the UI.
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.confidence - a.confidence),
    reputation: reputationRow
      ? {
          feedbackCount: reputationRow.feedbackCount,
          clientCount: reputationRow.clientCount,
          summaryValue,
          summaryDecimals,
          /*
           * Through `decodeScore`, not divided inline.
           *
           * This was the third path computing a score and the only one that skipped the
           * range check, so the list and search endpoints served values ERC-8004 does not
           * define as scores. A live agent came back at 141.33 on a 0-to-100 scale.
           *
           * `getSummary` averages whatever clients posted and the registry does not require
           * it to be a rating: a client may record a latency or a cost in the same field. A
           * value outside the range is therefore not a score at all, and `decodeScore`
           * returns null while `summaryValue` and `summaryDecimals` still carry what was
           * actually recorded.
           */
          score: decodeScore(summaryValue, summaryDecimals),
          source: reputationRow.source,
          computedAt: reputationRow.computedAt,
        }
      : null,
  };
}

export function createAgentRepository(db: Database): AgentRepository {
  /** Builds the shared WHERE clause for list and count so they cannot diverge. */
  function buildWhere(filters: ListAgentsFilters) {
    const conditions = [];

    if (filters.protocolTag) {
      conditions.push(eq(agents.protocolTag, filters.protocolTag));
    }

    if (filters.resolvedOnly === true) {
      conditions.push(sql`${agents.metadataResolvedAt} is not null`);
    }

    if (filters.query) {
      const term = `%${filters.query}%`;
      conditions.push(or(ilike(agents.name, term), ilike(agents.description, term)));
    }

    if (filters.traits && filters.traits.length > 0) {
      // AND semantics via array containment. Drizzle's helper is used rather than
      // a raw `@>` because a hand-written one binds the JS array without a
      // `::text[]` cast, which Postgres silently matches against nothing.
      conditions.push(arrayContains(agents.traitTags, filters.traits));
    }

    if (filters.category) {
      const categoryConditions = [eq(agentCategories.category, filters.category)];
      if (filters.minConfidence !== undefined) {
        categoryConditions.push(gte(agentCategories.confidence, filters.minConfidence));
      }
      conditions.push(
        sql`exists (select 1 from ${agentCategories} where ${and(
          eq(agentCategories.agentId, agents.id),
          ...categoryConditions,
        )})`,
      );
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  function orderBy(sort: AgentSortField, direction: 'asc' | 'desc') {
    const dir = direction === 'asc' ? asc : desc;

    switch (sort) {
      case 'name':
        return [dir(agents.name)];
      case 'feedback':
        // NULLS LAST both ways: an agent with no feedback should never outrank one
        // that has some just because the column is null.
        return [sql`${agentReputation.feedbackCount} ${sql.raw(direction)} nulls last`];
      case 'reputation':
        return [
          sql`(${agentReputation.summaryValue}::numeric / power(10, coalesce(${agentReputation.summaryDecimals}, 0))) ${sql.raw(direction)} nulls last`,
        ];
      case 'registered_at':
      default:
        /*
         * Ordered by agent id, and deliberately not by `registered_at`.
         *
         * The id is the better answer to "how recently did this register", not a fallback
         * for when the timestamp is missing. ERC-8004 mints ids from a sequential counter,
         * so a lower id registered earlier, always, for every row. It is the same
         * information as the timestamp and it is never null.
         *
         * `registered_at` is only populated for agents found by log replay, which is 466
         * of 317,476, because the ID-walk backfill does not read the `Registered` event and
         * free RPC tiers cannot serve enough log history to backfill it. Leading the sort
         * with `registered_at ... nulls last` therefore ranked by *which ingestion path
         * found the agent* before ranking by when it registered: those 466 rows are ids
         * 309,443 to 310,018 from one stale replay window, and they sorted ahead of 7,458
         * genuinely newer agents. "Recently registered" opened on an agent that was over
         * seven thousand registrations old, on both the discovery grid and the landing
         * page's arrivals list.
         */
        return [sql`${agents.agentId} ${sql.raw(direction)}`];
    }
  }

  return {
    async list(options: ListAgentsOptions): Promise<ListAgentsResult> {
      const where = buildWhere(options.filters);
      const offset = (options.page - 1) * options.perPage;

      const rows = await db
        .select({ agent: agents, reputation: agentReputation })
        .from(agents)
        .leftJoin(agentReputation, eq(agentReputation.agentId, agents.id))
        .where(where)
        .orderBy(...orderBy(options.sort, options.direction))
        .limit(options.perPage)
        .offset(offset);

      const [totalRow] = await db
        .select({ value: count() })
        .from(agents)
        .leftJoin(agentReputation, eq(agentReputation.agentId, agents.id))
        .where(where);

      if (rows.length === 0) {
        return { agents: [], total: totalRow?.value ?? 0 };
      }

      // One extra query for categories rather than N — the join would multiply
      // agent rows and force de-duplication in JS.
      const ids = rows.map((row) => row.agent.id);
      const categoryRows = await db
        .select()
        .from(agentCategories)
        .where(inArray(agentCategories.agentId, ids));

      const byAgent = new Map<string, (typeof agentCategories.$inferSelect)[]>();
      for (const categoryRow of categoryRows) {
        const bucket = byAgent.get(categoryRow.agentId);
        if (bucket) bucket.push(categoryRow);
        else byAgent.set(categoryRow.agentId, [categoryRow]);
      }

      return {
        agents: rows.map((row) =>
          toSummary(row.agent, row.reputation, byAgent.get(row.agent.id) ?? []),
        ),
        total: totalRow?.value ?? 0,
      };
    },

    async findById(id: string): Promise<AgentSummary | null> {
      const [row] = await db
        .select({ agent: agents, reputation: agentReputation })
        .from(agents)
        .leftJoin(agentReputation, eq(agentReputation.agentId, agents.id))
        .where(eq(agents.id, id))
        .limit(1);

      if (!row) return null;

      const categoryRows = await db
        .select()
        .from(agentCategories)
        .where(eq(agentCategories.agentId, id));

      return toSummary(row.agent, row.reputation, categoryRows);
    },

    /**
     * Idempotent write for the sync pipeline.
     *
     * Runs in one transaction per batch so a partially-written agent is never
     * visible: an agent row without its categories would show up in the
     * marketplace as uncategorised and quietly skew every category count.
     */
    async upsertMany(payloads: AgentWritePayload[]): Promise<number> {
      if (payloads.length === 0) return 0;

      await db.transaction(async (tx) => {
        for (const payload of payloads) {
          await tx
            .insert(agents)
            .values(payload.agent)
            .onConflictDoUpdate({
              target: agents.id,
              set: {
                ownerAddress: payload.agent.ownerAddress,
                walletAddress: payload.agent.walletAddress ?? null,
                agentUri: payload.agent.agentUri ?? null,
                name: payload.agent.name,
                description: payload.agent.description ?? null,
                protocolTag: payload.agent.protocolTag ?? 'unconfigured',
                traitTags: payload.agent.traitTags ?? [],
                capabilities: payload.agent.capabilities ?? [],
                rawMetadata: payload.agent.rawMetadata ?? null,
                metadataResolvedAt: payload.agent.metadataResolvedAt ?? null,
                lastSyncedAt: new Date(),
                updatedAt: new Date(),
              },
            });

          // Replace rather than merge: the classifier is deterministic, so its
          // current output is the whole truth. Merging would strand categories
          // from an older taxonomy version on the record forever.
          await tx.delete(agentCategories).where(eq(agentCategories.agentId, payload.agent.id));

          if (payload.categories.length > 0) {
            await tx.insert(agentCategories).values(
              payload.categories.map((assignment) => ({
                agentId: payload.agent.id,
                category: assignment.category,
                confidence: assignment.confidence,
                isPrimary: assignment.isPrimary,
                signals: assignment.signals,
                classifierVersion: assignment.classifierVersion,
              })),
            );
          }

          if (payload.reputation) {
            await tx
              .insert(agentReputation)
              .values({ agentId: payload.agent.id, ...payload.reputation })
              .onConflictDoUpdate({
                target: agentReputation.agentId,
                set: { ...payload.reputation, computedAt: new Date() },
              });
          }
        }
      });

      return payloads.length;
    },

    async findPendingMetadata(limit) {
      const rows = await db
        .select({
          id: agents.id,
          chainId: agents.chainId,
          agentId: agents.agentId,
          ownerAddress: agents.ownerAddress,
          walletAddress: agents.walletAddress,
          agentUri: agents.agentUri,
          registeredAtBlock: agents.registeredAtBlock,
          registeredAt: agents.registeredAt,
          source: agents.source,
        })
        .from(agents)
        .where(pendingMetadata())
        .orderBy(asc(agents.metadataAttempts), desc(agents.agentId))
        .limit(limit);

      // The URI is non-null by construction of the predicate; this narrows the type
      // without asserting it.
      return rows.flatMap((row) =>
        row.agentUri === null ? [] : [{ ...row, agentUri: row.agentUri }],
      );
    },

    async countPendingMetadata() {
      const [row] = await db.select({ value: count() }).from(agents).where(pendingMetadata());
      return row?.value ?? 0;
    },

    async recordMetadataFailures(ids, attemptedAt) {
      if (ids.length === 0) return;

      await db
        .update(agents)
        .set({
          metadataAttempts: sql`${agents.metadataAttempts} + 1`,
          metadataAttemptedAt: attemptedAt,
        })
        .where(inArray(agents.id, ids));
    },

    async findAgentIdsAfter(afterAgentId, limit) {
      return db
        .select({ id: agents.id, agentId: agents.agentId })
        .from(agents)
        .where(gt(agents.agentId, afterAgentId))
        .orderBy(asc(agents.agentId))
        .limit(limit);
    },

    async saveReputationSnapshots(snapshots) {
      if (snapshots.length === 0) return 0;

      const rows = snapshots.map((entry) => ({
        agentId: entry.id,
        feedbackCount: entry.reputation.feedbackCount,
        clientCount: entry.reputation.clientCount,
        summaryValue: entry.reputation.summaryValue,
        summaryDecimals: entry.reputation.summaryDecimals,
        source: entry.reputation.source,
        computedAt: entry.reputation.computedAt,
      }));

      await db
        .insert(agentReputation)
        .values(rows)
        .onConflictDoUpdate({
          target: agentReputation.agentId,
          set: {
            feedbackCount: sql`excluded.feedback_count`,
            clientCount: sql`excluded.client_count`,
            summaryValue: sql`excluded.summary_value`,
            summaryDecimals: sql`excluded.summary_decimals`,
            source: sql`excluded.source`,
            computedAt: sql`excluded.computed_at`,
          },
        });

      return rows.length;
    },
  };
}

/**
 * Agents whose registration file is genuinely still owed to us.
 *
 * `metadata_resolved_at IS NULL` on its own is the wrong filter: it also matches agents
 * with no URI at all, and agents whose document is permanently broken. Neither is fixable
 * by fetching, so including them would mean the backlog never drains and every pass
 * re-attempts the same dead rows.
 *
 * Restricting to https/ipfs selects exactly what discovery deferred. An unresolved inline
 * `data:` URI is a parse failure, not pending work, because discovery never defers those.
 */
function pendingMetadata() {
  return and(
    isNull(agents.metadataResolvedAt),
    or(ilike(agents.agentUri, 'https://%'), ilike(agents.agentUri, 'ipfs://%')),
  );
}
