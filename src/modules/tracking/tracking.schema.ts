import { z } from 'zod';

/**
 * Wire contract for campaign verification.
 *
 * Built for one reader: whoever is checking whether a wallet completed the Set and Earn quest.
 * The quest has two conditions — hire an agent in each of four categories, and list an agent of
 * your own — and neither is fully answerable from chain state alone, which is why this exists.
 *
 * WHY A HIRE IS NOT SELF-DESCRIBING ON CHAIN
 *
 * Hiring on KATTEGAT grants an Altana session key, registered in the public Keystore. The grant
 * is real, verifiable and revocable on chain, and `granted_tx_hash` lets anyone confirm it. What
 * the chain does *not* record is which agent it was for: a session is scoped to contract
 * addresses and a spend ceiling, not to an agent id. The agent association is KATTEGAT's, made
 * when the browser reports the grant and the backend verifies it against the Keystore before
 * storing it.
 *
 * So the honest split is: the authority is on chain, the pairing of authority to agent is here.
 * This endpoint serves the second half and points at the first.
 */

/** Case-insensitive on purpose. See the repository for why that is load bearing. */
export const walletParamSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address'),
});

/**
 * The four the campaign counts. Slugs, not labels, because these are compared not displayed.
 *
 * Kept here rather than imported from the classification taxonomy: the taxonomy is ours to widen
 * whenever the catalogue justifies it, and this list is a fixed external commitment for the
 * duration of the campaign. Coupling them would let a reclassification pass silently change what
 * quest completion means.
 */
export const QUEST_CATEGORIES = [
  'yield-optimization',
  'grid-trading',
  'rebalancing',
  'health-factor-monitoring',
] as const;

export const sessionStatusEnum = z.enum(['active', 'expired', 'revoked']);

export const trackedHireSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  /** The assignment KATTEGAT treats as the agent's category. Null when unclassified. */
  primary_category: z.string().nullable(),
  /** Every category assigned, so a multi-category agent is not flattened to one. */
  categories: z.array(z.string()),
  /** The session key. The identifier the Keystore and any revocation both use. */
  session_public_key: z.string(),
  /** The Altana account the session acts on, which is the user's own smart account. */
  wallet_address: z.string(),
  spend_limit_wei: z.string(),
  spend_period: z.string(),
  /** Contracts the session may call. Empty means no call restriction was set. */
  allowed_calls: z.array(z.string()),
  granted_at: z.string(),
  /** Null when the relay confirmed the grant without surfacing a receipt. */
  granted_tx_hash: z.string().nullable(),
  expires_at: z.string(),
  revoked_at: z.string().nullable(),
  revoked_tx_hash: z.string().nullable(),
  status: sessionStatusEnum,
});

export const listedAgentSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  /** Null across the board today: the backfill walks ids and records no registration block. */
  registered_at: z.string().nullable(),
  categories: z.array(z.string()),
});

export const trackedJobSchema = z.object({
  id: z.string(),
  chain_id: z.number().int(),
  job_id: z.number().int(),
  provider_address: z.string(),
  status: z.string(),
  /** Raw token units. Zero is a real case: the kernel allows a job that moves nothing. */
  budget_raw: z.string(),
  /**
   * When this job was last read from the kernel, not when it was funded.
   *
   * Named for what it is. The kernel exposes no creation timestamp, so a `created_at` here would
   * be an invented figure a verifier might reasonably rely on.
   */
  last_synced_at: z.string().nullable(),
});

export const questProgressSchema = z.object({
  required_categories: z.array(z.string()),
  /**
   * Categories this wallet has ever hired in.
   *
   * Counts a hire that was later revoked or has since expired, because the quest asks whether
   * the wallet hired, and revocation is a feature this product actively encourages rather than a
   * reason to withdraw credit. Per-hire `status` is on every entry if you would rather filter.
   */
  categories_hired: z.array(z.string()),
  categories_missing: z.array(z.string()),
  hired_all_four: z.boolean(),
  /** Agents in the catalogue whose on-chain owner is this wallet. */
  agents_listed_count: z.number().int(),
  listed_an_agent: z.boolean(),
  /** Both conditions met. The single field a verifier can read if it reads nothing else. */
  complete: z.boolean(),
});

export const walletTrackingResponseSchema = z.object({
  data: z.object({
    wallet_address: z.string(),
    quest: questProgressSchema,
    hires: z.array(trackedHireSchema),
    agents_listed: z.array(listedAgentSchema),
    /** Escrowed ERC-8183 jobs this wallet funded, which is what a deposit looks like here. */
    escrow_jobs: z.array(trackedJobSchema),
  }),
  meta: z.object({
    /** Where hiring settles. */
    hiring_chain_id: z.number().int(),
    network: z.string(),
    /** Where agents are read from, which is not the same chain. */
    registry_chain_id: z.number().int(),
    identity_registry: z.string(),
    /** The Altana Keystore a grant is registered in, and where a third party can verify it. */
    keystore_address: z.string(),
    /** Stated rather than assumed, because "hire" has to mean the same thing to both sides. */
    hire_definition: z.string(),
    /** How fresh the catalogue is, so a missing newly-listed agent has an explanation. */
    catalogue_last_indexed_at: z.string().nullable(),
  }),
});

export type WalletTrackingResponse = z.infer<typeof walletTrackingResponseSchema>;
