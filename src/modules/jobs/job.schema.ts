import { JOB_STATUS } from '@altananetwork/sdk';
import { z } from 'zod';

/**
 * Wire contract for ERC-8183 job evidence.
 *
 * Two shapes with different jobs to do. `agentJobsSchema` is the tally that travels with every
 * agent, cheap enough for a list of 24. `agentJobSchema` is one job, returned only from the
 * agent's own jobs endpoint.
 *
 * Amounts cross the wire as raw integer strings with the token's decimals beside them, the same
 * way reputation sends its fixed-point pair. A formatted number here would bake in a rounding
 * decision the client cannot undo, and these are settlement figures.
 */

/** Kernel status names rather than the raw index, plus the value we use when it is unknown. */
export const jobStatusEnum = z.enum([...JOB_STATUS, 'UNKNOWN']);

export const agentJobsSchema = z.object({
  /**
   * Every job naming this agent as provider, funded or not.
   *
   * Anyone can create a job against any address without paying, so this is a count of claims.
   * `funded` is the count that cost someone something. The gap between them is meaningful and
   * is why both are here rather than one number labelled "jobs".
   */
  total: z.number().int(),
  /** Jobs whose escrow was actually funded. */
  funded: z.number().int(),
  /** Jobs whose escrow was released to this agent. */
  completed: z.number().int(),
  /** Delivered and still inside the dispute window, so not yet released. */
  awaiting_release: z.number().int(),
  /** Escrow released to this agent, in raw token units. */
  settled_raw: z.string(),
  /** Escrow actually locked against this agent, whatever the outcome. Excludes unfunded. */
  escrowed_raw: z.string(),
  token_symbol: z.string(),
  token_decimals: z.number().int(),
  last_job_at: z.string().nullable(),
});

export const agentJobSchema = z.object({
  job_id: z.number().int(),
  chain_id: z.number().int(),
  status: jobStatusEnum,
  /** Who commissioned it. */
  client_address: z.string(),
  budget_raw: z.string(),
  /**
   * The task as the client wrote it on chain.
   *
   * Passed through unedited, including the ones that are a JSON quote rather than prose. It is
   * the commissioning text itself, so summarising it here would put our paraphrase in the place
   * where the evidence should be.
   */
  description: z.string(),
  expired_at: z.string(),
  submitted_at: z.string().nullable(),
  /** The provider's commitment to what it delivered. Null until submission. */
  deliverable_hash: z.string().nullable(),
});

/** Everything chain-specific the client needs, so no UI hardcodes a network. */
export const jobsContextSchema = z.object({
  chain_id: z.number().int(),
  /** The AgenticCommerce kernel holding the escrow, for independent verification. */
  commerce_address: z.string(),
  explorer_url: z.string(),
  token_symbol: z.string(),
  token_decimals: z.number().int(),
  /**
   * Seconds a submitted job waits before the escrow can be released.
   *
   * Read from the policy rather than assumed: seven days on mainnet against one on testnet. It
   * is what makes "delivered but not yet paid" an expected state rather than a stalled one.
   */
  dispute_window_seconds: z.number().int(),
  summary: agentJobsSchema,
});

export const listAgentJobsResponseSchema = z.object({
  data: z.array(agentJobSchema),
  meta: jobsContextSchema,
});

export type AgentJobsSummaryResponse = z.infer<typeof agentJobsSchema>;
export type AgentJobResponse = z.infer<typeof agentJobSchema>;
export type ListAgentJobsResponse = z.infer<typeof listAgentJobsResponseSchema>;
