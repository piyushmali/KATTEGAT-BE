import { z } from 'zod';

/**
 * Wire contract for hiring an agent.
 *
 * The shape of these requests is the shape of the architecture: the browser grants authority
 * with the user's passkey and then *reports* it, so a request here describes something that
 * already happened on chain rather than asking the backend to make it happen. Every field is
 * therefore a claim to be verified against the public Keystore, not an instruction.
 *
 * That is why there is no admin signature, no key material and no permission payload the
 * backend acts on. It could not act on one: authority belongs to the passkey in the user's
 * device.
 */

/** Rolling windows Altana accepts for a spend cap. */
export const SPEND_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a contract address');

/** Uncompressed secp256k1 or a Porto-format key. Bounded, and checked on chain regardless. */
const publicKey = z.string().regex(/^0x[0-9a-fA-F]{2,300}$/, 'expected a session public key');

const weiString = z.string().regex(/^\d{1,30}$/, 'expected a whole number of wei');

export const recordSessionBodySchema = z.object({
  /** The Altana wallet the session acts on. Verified to actually hold this key. */
  wallet_address: address,
  /** The granted session key. The identifier the Keystore and revocation both use. */
  public_key: publicKey,
  /**
   * The limits the browser granted, recorded for display.
   *
   * Not enforced by us and not enforceable by us: the account contract holds the real
   * permissions. These are stored so the marketplace can show a user what they granted
   * without reading and decoding the registry on every page load, and `hasAuthority` is what
   * decides whether the session is live.
   */
  spend_limit_wei: weiString,
  spend_period: z.enum(SPEND_PERIODS),
  /**
   * Contracts the session may call. Required and non-empty.
   *
   * An empty allowlist means "any target" to the account contract, which is the blanket
   * access this product refuses to offer. Refused at the boundary so nothing can record a
   * session as scoped when it is not.
   */
  allowed_targets: z.array(address).min(1).max(10),
  /** Unix seconds. Verified to be in the future. */
  expires_at_unix: z.coerce.number().int().positive(),
  /** The grant transaction, when the relay surfaced one. */
  granted_tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().optional(),
});

export type RecordSessionBody = z.infer<typeof recordSessionBodySchema>;

export const sponsorGasBodySchema = z.object({
  /** The wallet to top up. The user's own Altana account, derived from their passkey. */
  wallet_address: address,
});

export const agentSessionSchema = z.object({
  public_key: z.string(),
  agent_id: z.string(),
  wallet_address: z.string(),
  spend_limit_wei: z.string(),
  spend_period: z.string(),
  allowed_calls: z.array(z.string()),
  expires_at: z.string(),
  granted_at: z.string(),
  granted_tx_hash: z.string().nullable(),
  revoked_at: z.string().nullable(),
  revoked_tx_hash: z.string().nullable(),
  chain_id: z.number().int(),
  /**
   * Derived from the chain, not from our columns.
   *
   * `active` means the Keystore still reports authority for this key. Reading our own
   * `revoked_at` would miss a revocation made anywhere else: through another app, or through
   * the Altana MCP server in Claude. The registry is the source of truth and this follows it.
   */
  status: z.enum(['active', 'expired', 'revoked']),
});

export type AgentSessionResponse = z.infer<typeof agentSessionSchema>;

/** Everything chain-specific the UI needs, so it never hardcodes a network. */
const hiringContextSchema = z.object({
  /** False when this deployment cannot verify authority, which disables hiring. */
  enabled: z.boolean(),
  chain_id: z.number().int(),
  /** `bnb-testnet` or `bnb`. The UI says which, because it changes what a mistake costs. */
  network: z.string(),
  /** True on mainnet. Drives the copy that warns real funds are involved. */
  is_mainnet: z.boolean(),
  /** `BNB` or `tBNB`. Wrong on the other chain, so it is never hardcoded in the UI. */
  native_symbol: z.string(),
  explorer_url: z.string(),
  /** Public Keystore address, so anyone can verify authority without asking us. */
  keystore_address: z.string(),
  /** True when the backend will fund a new wallet's gas. */
  gas_sponsored: z.boolean(),
});

export const listSessionsResponseSchema = z.object({
  data: z.array(agentSessionSchema),
  meta: hiringContextSchema,
});

export const recordSessionResponseSchema = z.object({
  data: agentSessionSchema,
  meta: hiringContextSchema,
});

export const sponsorGasResponseSchema = z.object({
  data: z.object({
    /** Null when the wallet already had enough gas, which is a success. */
    transaction_hash: z.string().nullable(),
    amount_wei: z.string().nullable(),
    /** Where the funds came from, so a user can see it was not their own balance. */
    sponsor_address: z.string().nullable(),
    /** False when sponsorship is off. The user funds their own gas and hiring still works. */
    sponsored: z.boolean(),
  }),
});

export const sessionKeyParamSchema = z.object({ public_key: publicKey });
