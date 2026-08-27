import { z } from 'zod';

/** Wire contract for the reputation domain. */

/**
 * Where a reputation figure came from.
 *
 * Exposed rather than hidden because the answer changes how much a user should
 * trust the number: `chain` is authoritative and read live, `snapshot` is our
 * cached copy and may lag, `explorer` is a third party's computed score.
 */
export const reputationOriginEnum = z.enum(['chain', 'snapshot', 'explorer']);

export const reputationSubScoresSchema = z.object({
  feedback: z.number().nullable(),
  validation: z.number().nullable(),
  sybil_resistance: z.number().nullable(),
  reliability: z.number().nullable(),
});

/** Optional enrichment from the ERC-8004 Explorer, when it is configured. */
export const explorerReputationSchema = z.object({
  score: z.number().nullable(),
  confidence: z.string().nullable(),
  formula_version: z.string().nullable(),
  sub_scores: reputationSubScoresSchema,
});

export const agentReputationDetailSchema = z.object({
  agent_id: z.string(),
  /** Non-revoked feedback entries included in the summary. */
  feedback_count: z.number().int(),
  /** Distinct client addresses that have left feedback — the anti-sybil signal. */
  client_count: z.number().int(),
  /**
   * Fixed-point pair exactly as the ReputationRegistry returned it. The real
   * value is `summary_value / 10^summary_decimals`; both halves are exposed so a
   * client can render the on-chain figure without trusting our rounding.
   */
  summary_value: z.number().nullable(),
  summary_decimals: z.number().int().nullable(),
  /** Decoded score. Null means no feedback exists — not a score of zero. */
  score: z.number().nullable(),
  origin: reputationOriginEnum,
  computed_at: z.string(),
  /**
   * Plain-language notes about this reading, e.g. that the live read failed and a
   * cached snapshot was served instead. Rendered directly, so the UI never has to
   * guess why a number looks stale.
   */
  notes: z.array(z.string()),
  explorer: explorerReputationSchema.nullable(),
});

export const agentReputationResponseSchema = z.object({ data: agentReputationDetailSchema });

export type AgentReputationDetail = z.infer<typeof agentReputationDetailSchema>;
export type AgentReputationResponse = z.infer<typeof agentReputationResponseSchema>;
