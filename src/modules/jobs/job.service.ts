import { notFound } from '../../shared/errors.js';
import { PAYMENT_TOKEN, type Erc8183JobReader } from '../../integrations/erc8183/job-reader.js';
import type { AgentRepository } from '../agents/agent.repository.js';
import { toWireJob, toWireJobSummary } from './job.mapper.js';
import type { JobRepository } from './job.repository.js';
import type { ListAgentJobsResponse } from './job.schema.js';

/**
 * Reading an agent's escrow history.
 *
 * Serves from our mirror of the kernel rather than from chain, because rendering one page would
 * otherwise mean a read per job. The mirror is refreshed by the job sweep, so the honest failure
 * is a status being minutes stale, never a job existing here that does not exist on chain.
 *
 * `meta` carries the kernel address and the dispute window so a visitor can check any of it
 * against BscScan without taking our word for it, which is the whole point of showing escrow
 * rather than a rating.
 */

export interface JobService {
  listForAgent(agentId: string, limit: number): Promise<ListAgentJobsResponse>;
}

export interface JobServiceDeps {
  repository: JobRepository;
  agents: AgentRepository;
  reader: Erc8183JobReader;
}

export function createJobService({ repository, agents, reader }: JobServiceDeps): JobService {
  return {
    async listForAgent(agentId, limit) {
      if ((await agents.findById(agentId)) === null) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const [rows, summary, policy] = await Promise.all([
        repository.listForAgent(agentId, limit),
        repository.summaryForAgent(agentId),
        /*
         * The window of the policy actually in use, not of the one the SDK pins. They differ:
         * on testnet the pinned policy is not whitelisted and holds a 24 hour window while the
         * accepted one holds 15 minutes. Reporting the wrong one would tell a client their money
         * moves on a day it does not.
         */
        reader.escrowPolicy(),
      ]);

      return {
        data: rows.map(toWireJob),
        meta: {
          chain_id: reader.chainId,
          commerce_address: reader.addresses.commerce,
          explorer_url: reader.explorerUrl,
          token_symbol: PAYMENT_TOKEN.symbol,
          token_decimals: PAYMENT_TOKEN.decimals,
          dispute_window_seconds: policy.disputeWindowSeconds,
          summary: toWireJobSummary(summary),
        },
      };
    },
  };
}
