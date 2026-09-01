import { JOB_STATUS } from '@altananetwork/sdk';
import type { AgentJobRow } from '../../infrastructure/database/schema.js';
import { PAYMENT_TOKEN } from '../../integrations/erc8183/job-reader.js';
import type { AgentJobResponse, AgentJobsSummaryResponse } from './job.schema.js';
import type { JobSummary } from './job.repository.js';

/**
 * Job evidence to wire format.
 *
 * Its own file for the same reason the agent mapper is: the tally is attached to agents by the
 * agent service while individual jobs are served by the jobs routes, and two copies of the
 * snake_case mapping is how the two start disagreeing about the same job.
 */

export function toWireJobSummary(summary: JobSummary): AgentJobsSummaryResponse {
  return {
    total: summary.total,
    funded: summary.funded,
    completed: summary.completed,
    awaiting_release: summary.awaitingRelease,
    settled_raw: summary.settledRaw,
    escrowed_raw: summary.escrowedRaw,
    token_symbol: PAYMENT_TOKEN.symbol,
    token_decimals: PAYMENT_TOKEN.decimals,
    last_job_at: summary.lastJobAt?.toISOString() ?? null,
  };
}

export function toWireJob(row: AgentJobRow): AgentJobResponse {
  return {
    job_id: row.jobId,
    chain_id: row.chainId,
    /*
     * The name, not the index. `UNKNOWN` rather than a guess if the kernel ever adds a status:
     * showing an unrecognised state honestly is better than mapping it onto a neighbour and
     * telling someone their escrow settled.
     */
    status: JOB_STATUS[row.status] ?? 'UNKNOWN',
    client_address: row.clientAddress,
    budget_raw: row.budgetRaw,
    description: row.description,
    expired_at: row.expiredAt.toISOString(),
    submitted_at: row.submittedAt?.toISOString() ?? null,
    deliverable_hash: row.deliverableHash,
  };
}
