import { z } from 'zod';
import { PROTOCOL_TAGS } from '../../integrations/erc8004/registration-file.js';
import { AGENT_CATEGORIES } from '../classification/taxonomy.js';
import { paginationSchema } from '../../shared/http/api.schema.js';
import { ENDPOINT_KINDS } from './agent.types.js';

/**
 * Wire contract for the agents domain.
 *
 * These schemas are the single source of truth for agent payloads: Fastify
 * validates requests and serialises responses from them, @fastify/swagger derives
 * the OpenAPI document from them, and the frontend re-declares the same shapes to
 * parse against (KATTEGAT-FE src/lib/api/contract.ts).
 *
 * Field names are snake_case on the wire and camelCase internally. Explicit, and
 * it keeps a rename of an internal field from silently breaking the frontend.
 */

export const agentCategoryEnum = z.enum(AGENT_CATEGORIES);
export const protocolTagEnum = z.enum(PROTOCOL_TAGS);

export const sortFieldEnum = z.enum(['registered_at', 'reputation', 'name', 'feedback']);
export const sortDirectionEnum = z.enum(['asc', 'desc']);

/* -------------------------------- requests -------------------------------- */

/**
 * Filters usable on any agent collection.
 *
 * Extracted from the list query so the search module can accept the identical
 * filter vocabulary without redeclaring (or drifting from) it.
 */
export const agentFilterQuerySchema = z.object({
  category: agentCategoryEnum.optional(),
  protocol: protocolTagEnum.optional(),
  /** Free-text over name and description. */
  q: z.string().trim().min(1).max(200).optional(),
  /** Repeatable: `?trait=x402-paid&trait=multichain` requires both. */
  trait: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string().max(60)).max(10))
    .optional(),
  /** Hide agents whose registration file never resolved. */
  resolved_only: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  min_confidence: z.coerce.number().min(0).max(1).optional(),
});

export const listAgentsQuerySchema = agentFilterQuerySchema.extend({
  sort: sortFieldEnum.default('registered_at'),
  direction: sortDirectionEnum.default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(24),
});

export type AgentFilterQuery = z.infer<typeof agentFilterQuerySchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

export const agentIdParamSchema = z.object({
  /** `${chainId}:${agentId}`, e.g. `56:309393`. */
  id: z
    .string()
    .regex(/^\d+:\d+$/, 'expected an agent id in the form <chainId>:<agentId>')
    .max(80),
});

/* -------------------------------- responses ------------------------------- */

export const agentIdentitySchema = z.object({
  id: z.string(),
  chain_id: z.number().int(),
  agent_id: z.number().int(),
  owner_address: z.string(),
  wallet_address: z.string().nullable(),
  agent_uri: z.string().nullable(),
  registered_at_block: z.number().int().nullable(),
  registered_at: z.string().nullable(),
});

export const agentEndpointSchema = z.object({
  /** The operator's label for this endpoint, e.g. `A2A`. Null when unset. */
  label: z.string().nullable(),
  /**
   * The endpoint exactly as published on chain.
   *
   * Not every endpoint is a URL: some are CAIP-10 contract references, some use
   * `mcp://`. This field is what the UI displays, so a visitor always sees the real
   * value rather than a gap where KATTEGAT could not linkify it.
   */
  value: z.string(),
  /**
   * The same endpoint as a link target, or null when it is not a safe one.
   *
   * Only absolute `https:` URLs are offered. The value is untrusted on-chain input and
   * an `href` is a place where `javascript:` executes, so this filter is server-side and
   * not left to each client to remember.
   */
  url: z.string().nullable(),
  kind: z.enum(ENDPOINT_KINDS),
  version: z.string().nullable(),
});

export const agentProfileSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  capabilities: z.array(z.string()),
  protocol_tag: z.string(),
  trait_tags: z.array(z.string()),
  /**
   * Where the agent can be reached, from the `services` array of its registration file.
   *
   * Empty when it declared none, which is a real state rather than missing data: an
   * agent with no endpoint has an on-chain identity and nothing listening behind it, and
   * `protocol_tag` reads `unconfigured` to match.
   */
  endpoints: z.array(agentEndpointSchema),
  /** Trust models the operator declared, in their own wording. */
  trust_models: z.array(z.string()),
  /** Whether the agent accepts x402 pay-per-call. Null when it did not say. */
  x402_support: z.boolean().nullable(),
  /**
   * The operator's own claim that the agent is running. A claim, not a measurement.
   * Null when unstated, which is distinct from a declared `false`.
   */
  declared_active: z.boolean().nullable(),
  /**
   * The agent's own artwork, taken from the `image` field of its registration file.
   *
   * Always an absolute `https:` URL or null — the value is written on chain by whoever
   * registered the agent, so it is validated server-side before it is offered to a
   * browser. Clients still need a fallback: the host is a third party and may be gone.
   */
  image_url: z.string().nullable(),
  /**
   * Null means the off-chain registration file could not be fetched or parsed.
   * The agent is still real — its identity is on-chain — so the UI should render
   * a partial state rather than hide it.
   */
  metadata_resolved_at: z.string().nullable(),
});

export const agentCategoryAssignmentSchema = z.object({
  category: agentCategoryEnum,
  confidence: z.number().min(0).max(1),
  is_primary: z.boolean(),
  /** Why the classifier matched, e.g. `capability:rebalance`. Rendered in the UI. */
  signals: z.array(z.string()),
  classifier_version: z.string(),
});

export const agentReputationSchema = z.object({
  feedback_count: z.number().int(),
  client_count: z.number().int(),
  /**
   * Fixed-point pair straight from the ERC-8004 ReputationRegistry. `score` is
   * the decoded `summary_value / 10^summary_decimals`. Both are exposed so a
   * client can render the exact on-chain value rather than trusting our rounding.
   */
  summary_value: z.number().nullable(),
  summary_decimals: z.number().int().nullable(),
  /** Null when the agent has no feedback at all — distinct from a score of 0. */
  score: z.number().nullable(),
  source: z.string(),
  computed_at: z.string(),
});

export const agentSummarySchema = z.object({
  identity: agentIdentitySchema,
  profile: agentProfileSchema,
  categories: z.array(agentCategoryAssignmentSchema),
  reputation: agentReputationSchema.nullable(),
});

export const listAgentsResponseSchema = z.object({
  data: z.array(agentSummarySchema),
  meta: paginationSchema,
});

export const agentDetailResponseSchema = z.object({ data: agentSummarySchema });

export type AgentSummaryResponse = z.infer<typeof agentSummarySchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
