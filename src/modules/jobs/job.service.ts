import type { Logger } from 'pino';
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
  logger: Logger;
}

/** How long a dispute window reading is reused. It is a deployment constant in practice. */
const DISPUTE_WINDOW_TTL_MS = 60 * 60 * 1000;

export function createJobService({ repository, agents, reader, logger }: JobServiceDeps): JobService {
  /*
   * Cached, because it is read from the policy contract on a path that renders a page, and the
   * value changes only if the stack is redeployed. Held as the promise so concurrent first
   * requests share one read rather than racing several.
   */
  let disputeWindow: { value: Promise<number>; at: number } | null = null;

  const disputeWindowSeconds = (): Promise<number> => {
    if (disputeWindow === null || Date.now() - disputeWindow.at > DISPUTE_WINDOW_TTL_MS) {
      disputeWindow = {
        at: Date.now(),
        value: reader.disputeWindowSeconds().catch((error: unknown) => {
          /*
           * Cleared so the next request retries rather than caching a failure for an hour.
           * Rethrown, because a wrong dispute window would misreport when someone's money
           * moves, and that is worse than an error the client can retry.
           */
          disputeWindow = null;
          logger.warn({ err: error }, 'could not read the ERC-8183 dispute window');
          throw error;
        }),
      };
    }

    return disputeWindow.value;
  };

  return {
    async listForAgent(agentId, limit) {
      if ((await agents.findById(agentId)) === null) {
        throw notFound(`No agent with id "${agentId}" has been indexed.`);
      }

      const [rows, summary, window] = await Promise.all([
        repository.listForAgent(agentId, limit),
        repository.summaryForAgent(agentId),
        disputeWindowSeconds(),
      ]);

      return {
        data: rows.map(toWireJob),
        meta: {
          chain_id: reader.chainId,
          commerce_address: reader.addresses.commerce,
          explorer_url: reader.explorerUrl,
          token_symbol: PAYMENT_TOKEN.symbol,
          token_decimals: PAYMENT_TOKEN.decimals,
          dispute_window_seconds: window,
          summary: toWireJobSummary(summary),
        },
      };
    },
  };
}
