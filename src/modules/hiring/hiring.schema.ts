import { z } from 'zod';
import { SPEND_PERIODS } from '../../integrations/altana/session-authority.js';

/**
 * Wire contract for hiring an agent.
 *
 * A hire is a grant of scoped authority, so the request body is the scope: how much, over
 * what window, until when, and to which contracts. Those four are the product's safety
 * promise and they are validated here before anything touches a chain, because a request
 * that fails validation costs nothing while a bad grant costs a transaction.
 */

/** Ceiling in wei, as a decimal string. */
const WEI_PATTERN = /^\d{1,30}$/;

const weiString = z
  .string()
  .regex(WEI_PATTERN, 'expected a whole number of wei as a decimal string')
  /*
   * Re-tests the pattern before converting, rather than relying on `.regex` above having
   * stopped things.
   *
   * Zod 4 runs every check on a value instead of short-circuiting at the first failure, so
   * this refinement still sees `"0.01"` after the regex has already rejected it, and a bare
   * `BigInt(value)` throws a SyntaxError out of validation. The result was a 500 on input the
   * schema had correctly identified as invalid.
   */
  .refine(
    (value) => WEI_PATTERN.test(value) && BigInt(value) > 0n,
    'a spend ceiling of zero grants nothing',
  );

export const grantSessionBodySchema = z.object({
  /**
   * Wei rather than a decimal token amount.
   *
   * A float would introduce a rounding question in the one field where the answer is
   * someone's money. The UI converts once, deliberately, and sends the integer.
   */
  spend_limit_wei: weiString,
  spend_period: z.enum(SPEND_PERIODS),
  /**
   * How long the authority lasts, in minutes.
   *
   * Relative rather than an absolute timestamp: a client whose clock is wrong would
   * otherwise grant authority that has already expired, or lasts far longer than the user
   * chose. Bounded at a week, because "indefinite" is not a session.
   */
  duration_minutes: z.coerce.number().int().min(1).max(10_080),
  /**
   * Contracts the session may call. Required and non-empty.
   *
   * An empty allowlist means "any target" to the account contract, which is precisely the
   * blanket access this product refuses to offer. Refused at the boundary rather than
   * defaulted, so nothing can grant it by omission.
   */
  allowed_targets: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a contract address'))
    .min(1, 'name at least one contract the agent may call')
    .max(10),
});

export type GrantSessionBody = z.infer<typeof grantSessionBodySchema>;

export const agentSessionSchema = z.object({
  /** Identifies the session on chain, and is what revocation takes. */
  public_key: z.string(),
  agent_id: z.string(),
  wallet_address: z.string(),
  spend_limit_wei: z.string(),
  spend_period: z.string(),
  allowed_calls: z.array(z.string()),
  expires_at: z.string(),
  granted_at: z.string(),
  /** Null when the relay confirmed the grant without surfacing a receipt. */
  granted_tx_hash: z.string().nullable(),
  revoked_at: z.string().nullable(),
  revoked_tx_hash: z.string().nullable(),
  chain_id: z.number().int(),
  /**
   * Derived, not stored.
   *
   * `active` requires both not revoked and not expired. Two separate ways for authority to
   * end, and a UI that only checked one would show an expired session as live.
   */
  status: z.enum(['active', 'expired', 'revoked']),
});

export const grantSessionResponseSchema = z.object({
  data: agentSessionSchema,
  meta: z.object({
    /** False when the Keystore write could not be confirmed. The session still works. */
    keystore_registered: z.boolean(),
    /** Base explorer URL, so a client never hardcodes a chain's host. */
    explorer_url: z.string(),
  }),
});

export const listSessionsResponseSchema = z.object({
  data: z.array(agentSessionSchema),
  meta: z.object({
    /** False when this deployment has no signer configured, so hiring is unavailable. */
    enabled: z.boolean(),
    chain_id: z.number().int(),
    explorer_url: z.string(),
    /**
     * True when grants are made on a KATTEGAT-operated testnet account rather than the
     * visitor's own wallet. Returned so the UI cannot forget to say so.
     */
    sandbox: z.boolean(),
  }),
});

export const sessionKeyParamSchema = z.object({
  public_key: z.string().regex(/^0x[0-9a-fA-F]{2,300}$/, 'expected a session public key'),
});

export type AgentSessionResponse = z.infer<typeof agentSessionSchema>;
