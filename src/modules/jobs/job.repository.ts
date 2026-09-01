import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database/client.js';
import { agentJobs, type AgentJobRow } from '../../infrastructure/database/schema.js';
import {
  FIRST_TERMINAL_STATUS,
  JOB_STATUS_INDEX,
  type JobRead,
} from '../../integrations/erc8183/job-reader.js';

/**
 * Persistence for ERC-8183 jobs.
 *
 * A mirror of the escrow kernel. Same standing as the sessions table: if this disagrees with
 * chain, chain is right, and the acceptable failure is being behind rather than being wrong.
 *
 * The one thing here that is ours rather than the chain's is which agent a job belongs to, and
 * that is computed rather than trusted. See `reattribute`.
 */

/**
 * What an agent's job history adds up to. Read from chain, and deliberately split by whether
 * money actually moved rather than by whether a job exists.
 */
export interface JobSummary {
  /** Every job naming this agent, including ones created and never funded. */
  total: number;
  /**
   * Jobs whose escrow was genuinely funded.
   *
   * The honest denominator, and not the same as `total`. Anyone can create a job naming any
   * provider and never fund it, so `total` is a claim by a client while this is a fact about
   * tokens. An agent with many jobs and no funded ones has been named, not hired.
   */
  funded: number;
  /** Escrow released to this agent. The strongest single figure here. */
  completed: number;
  /** Delivered and still inside the dispute window, so not yet released. */
  awaitingRelease: number;
  /** Escrow that actually reached this agent, in raw $U units. */
  settledRaw: string;
  /** Escrow that was actually locked, whatever the outcome. Excludes unfunded jobs. */
  escrowedRaw: string;
  /** Most recent job expiry we know of, as a cheap proxy for "still active". */
  lastJobAt: Date | null;
}

export interface JobRepository {
  /** Upserts what the chain says. Returns how many rows were written. */
  save(jobs: readonly JobRead[]): Promise<number>;
  /**
   * Recomputes provider-to-agent links, in both directions. Returns rows changed.
   */
  reattribute(): Promise<number>;
  /** Non-terminal job ids after a cursor, oldest first, for the refresh pass. */
  findPendingJobIdsAfter(chainId: number, afterJobId: number, limit: number): Promise<number[]>;
  /** How many non-terminal jobs are left beyond this cursor. */
  countPendingAfter(chainId: number, afterJobId: number): Promise<number>;
  summaryForAgent(agentId: string): Promise<JobSummary>;
  /**
   * Summaries for a page of agents in one query.
   *
   * Agents with no jobs are absent from the map rather than present with zeroes, so a caller
   * can tell "never hired" from "hired and delivered nothing". Those are different claims and
   * the UI says different things about them.
   */
  summariesForAgents(agentIds: readonly string[]): Promise<Map<string, JobSummary>>;
  listForAgent(agentId: string, limit: number): Promise<AgentJobRow[]>;
}

/**
 * Normalises whatever the driver hands back for `max(timestamptz)`.
 *
 * Needed because `sql<Date | null>` is an assertion, not a conversion. Drizzle applies a
 * column's type mapper to selected columns but not to an aggregate written as raw SQL, so this
 * arrives as a string and the declared type quietly disagrees with the value. It reached a
 * response as `summary.lastJobAt?.toISOString is not a function`.
 *
 * Converted here rather than by widening the domain type to `Date | string`, which would push
 * the same ambiguity onto every caller.
 */
const toDate = (value: Date | string | null): Date | null => {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
};

/** The aggregate columns, shared by the single and batch summary queries. */
const summaryColumns = {
  total: sql<number>`count(*)::int`,
  /* Anything past OPEN was funded: the kernel has no route back from FUNDED to OPEN. */
  funded: sql<number>`count(*) FILTER (WHERE ${agentJobs.status} > ${JOB_STATUS_INDEX.open})::int`,
  completed: sql<number>`count(*) FILTER (WHERE ${agentJobs.status} = ${JOB_STATUS_INDEX.completed})::int`,
  awaitingRelease: sql<number>`count(*) FILTER (WHERE ${agentJobs.status} = ${JOB_STATUS_INDEX.submitted})::int`,
  /*
   * Summed in Postgres over `numeric`, not in JS. $U carries 18 decimals, so these totals
   * routinely exceed what a double holds exactly, and a settled figure that is off in its low
   * digits is worse than no figure at all.
   */
  settledRaw: sql<string>`coalesce(sum(${agentJobs.budgetRaw}) FILTER (WHERE ${agentJobs.status} = ${JOB_STATUS_INDEX.completed}), 0)::text`,
  /* Funded jobs only. An OPEN job's budget was set, not escrowed. */
  escrowedRaw: sql<string>`coalesce(sum(${agentJobs.budgetRaw}) FILTER (WHERE ${agentJobs.status} > ${JOB_STATUS_INDEX.open}), 0)::text`,
  lastJobAt: sql<Date | string | null>`max(${agentJobs.expiredAt})`,
};

export function createJobRepository(db: Database): JobRepository {
  return {
    async save(jobs) {
      if (jobs.length === 0) return 0;

      const rows = jobs.map((job) => ({
        id: `${String(job.chainId)}:${String(job.jobId)}`,
        chainId: job.chainId,
        jobId: job.jobId,
        clientAddress: job.clientAddress,
        providerAddress: job.providerAddress,
        evaluatorAddress: job.evaluatorAddress,
        budgetRaw: job.budgetRaw,
        status: job.status,
        description: job.description,
        expiredAt: job.expiredAt,
        submittedAt: job.submittedAt,
        deliverableHash: job.deliverableHash,
        lastSyncedAt: new Date(),
      }));

      const written = await db
        .insert(agentJobs)
        .values(rows)
        .onConflictDoUpdate({
          target: agentJobs.id,
          /*
           * Everything the kernel owns is overwritten, because a job is not write-once: a
           * provider submits, an evaluator settles, and `setBudget` can still move the figure
           * while the job is unfunded.
           *
           * `agentId` is deliberately absent. It is computed here rather than read from
           * `getJob`, so listing it would have every sweep wipe the attribution pass's work.
           */
          set: {
            status: sql`excluded.status`,
            budgetRaw: sql`excluded.budget_raw`,
            description: sql`excluded.description`,
            expiredAt: sql`excluded.expired_at`,
            submittedAt: sql`excluded.submitted_at`,
            deliverableHash: sql`excluded.deliverable_hash`,
            lastSyncedAt: sql`excluded.last_synced_at`,
          },
        })
        .returning({ id: agentJobs.id });

      return written.length;
    },

    /**
     * Links jobs to agents, and unlinks them when the link stops being justified.
     *
     * The kernel names a provider address; this marketplace is a catalogue of agent ids. The
     * join is the agent's own wallet address, and it only holds when that address belongs to
     * exactly one indexed agent. Measured against a sample of mainnet jobs: 45 of 74 provider
     * addresses resolved to a single agent, and 12 resolved to several, one of them being the
     * wallet of 768 different agents. Crediting all 768 with the same delivery, or silently
     * choosing one, would be inventing a track record. Those stay null.
     *
     * A full recompute rather than filling in the blanks, because agents can call
     * `setAgentWallet` at any time. An address that uniquely identified one agent when a job
     * was indexed can later be adopted by a second, which makes the original attribution
     * unjustified. Only writing null rows would leave that first link in place for ever,
     * showing one agent's escrow history on another's page. `IS DISTINCT FROM` keeps it cheap
     * and idempotent: rows whose answer has not changed are not written.
     */
    async reattribute() {
      const result = await db.execute(sql`
        UPDATE ${agentJobs} AS j
        SET agent_id = resolved.agent_id
        FROM (
          SELECT
            job.id AS job_id,
            unique_wallet.agent_id
          FROM ${agentJobs} AS job
          LEFT JOIN (
            SELECT wallet_address AS addr, min(id) AS agent_id
            FROM agents
            WHERE wallet_address IS NOT NULL
            GROUP BY wallet_address
            HAVING count(*) = 1
          ) AS unique_wallet ON unique_wallet.addr = job.provider_address
        ) AS resolved
        WHERE j.id = resolved.job_id
          AND j.agent_id IS DISTINCT FROM resolved.agent_id
        RETURNING j.id
      `);

      return result.length;
    },

    async findPendingJobIdsAfter(chainId, afterJobId, limit) {
      const rows = await db
        .select({ jobId: agentJobs.jobId })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.chainId, chainId),
            lt(agentJobs.status, FIRST_TERMINAL_STATUS),
            sql`${agentJobs.jobId} > ${afterJobId}`,
          ),
        )
        .orderBy(asc(agentJobs.jobId))
        .limit(limit);

      return rows.map((row) => row.jobId);
    },

    async countPendingAfter(chainId, afterJobId) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.chainId, chainId),
            lt(agentJobs.status, FIRST_TERMINAL_STATUS),
            sql`${agentJobs.jobId} > ${afterJobId}`,
          ),
        );

      return row?.count ?? 0;
    },

    async summaryForAgent(agentId) {
      const [row] = await db
        .select(summaryColumns)
        .from(agentJobs)
        .where(eq(agentJobs.agentId, agentId));

      return {
        total: row?.total ?? 0,
        funded: row?.funded ?? 0,
        completed: row?.completed ?? 0,
        awaitingRelease: row?.awaitingRelease ?? 0,
        settledRaw: row?.settledRaw ?? '0',
        escrowedRaw: row?.escrowedRaw ?? '0',
        lastJobAt: toDate(row?.lastJobAt ?? null),
      };
    },

    async summariesForAgents(agentIds) {
      const out = new Map<string, JobSummary>();
      if (agentIds.length === 0) return out;

      const rows = await db
        .select({ agentId: agentJobs.agentId, ...summaryColumns })
        .from(agentJobs)
        .where(inArray(agentJobs.agentId, [...agentIds]))
        .groupBy(agentJobs.agentId);

      for (const row of rows) {
        /* Narrowing only: rows are grouped by a column the `inArray` already made non-null. */
        if (row.agentId === null) continue;

        out.set(row.agentId, {
          total: row.total,
          funded: row.funded,
          completed: row.completed,
          awaitingRelease: row.awaitingRelease,
          settledRaw: row.settledRaw,
          escrowedRaw: row.escrowedRaw,
          lastJobAt: toDate(row.lastJobAt),
        });
      }

      return out;
    },

    async listForAgent(agentId, limit) {
      return db
        .select()
        .from(agentJobs)
        .where(eq(agentJobs.agentId, agentId))
        .orderBy(desc(agentJobs.jobId))
        .limit(limit);
    },
  };
}
