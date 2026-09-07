import { z } from 'zod';

/**
 * Environment contract for the KATTEGAT backend.
 *
 * Parsed once, at startup, before the server binds a port. A bad deploy should
 * fail immediately with a readable report rather than throwing on the first
 * request that happens to touch the missing value.
 */

const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** `"a, b"` -> `['a','b']`, dropping blanks so a trailing comma is harmless. */
const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.string()));

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /**
     * Interface to bind. Left without a default here because the right one depends on
     * NODE_ENV, which is resolved in the transform below.
     */
    HOST: z.string().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: csv.default(['http://localhost:3000']),

    DATABASE_URL: z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

    BSC_RPC_URL: z.url().default('https://bsc-rpc.publicnode.com'),
    BSC_RPC_URL_FALLBACK: z.url().optional(),

    /**
     * `.prefault` rather than `.default`: Zod's `.default()` short-circuits and
     * returns the literal untouched, so a checksummed default would skip the
     * lowercasing that provided values get and produce addresses that compare
     * unequal depending on whether the operator set the variable.
     */
    ERC8004_IDENTITY_REGISTRY: evmAddress.prefault('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'),
    ERC8004_REPUTATION_REGISTRY: evmAddress.prefault('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'),
    ERC8004_DEPLOY_BLOCK: z.coerce.number().int().min(0).default(0),
    /**
     * eth_getLogs window size. The floor is 1, not a comfortable round number:
     * Alchemy's free tier caps this method at 10 blocks, so a minimum of 100 would
     * reject a perfectly valid configuration. Providers differ wildly here — see
     * docs/integrations.md for the measured limits.
     */
    ERC8004_LOG_CHUNK_SIZE: z.coerce.number().int().min(1).max(50_000).default(2_000),
    /**
     * Hard cap on how far back a sync will look. Public BSC endpoints only serve
     * a short window of logs (measured at ~8k blocks); asking for more returns an
     * archive-access error rather than data. See docs/integrations.md.
     */
    ERC8004_MAX_LOOKBACK_BLOCKS: z.coerce.number().int().min(100).max(50_000_000).default(8_000),
    IPFS_GATEWAY_URL: z.url().default('https://ipfs.io/ipfs/'),

    ERC8004_EXPLORER_ENABLED: booleanish.default(false),
    ERC8004_EXPLORER_BASE_URL: z.url().default('https://erc-8004.quicknode.com'),

    AI_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
    AI_BASE_URL: z.string().default(''),
    AI_API_KEY: z.string().default(''),
    AI_MODEL: z.string().default(''),

    /* ----------------------------- agent hiring ---------------------------- */

    /**
     * Which Altana network hiring runs on.
     *
     * The whole point of this being configuration: going live is a change to this value and
     * to the sponsor key, not a change to code. Nothing downstream hardcodes a chain id, an
     * explorer host or a token symbol; they all derive from the resolved network and are
     * carried to the browser through the API.
     *
     * Defaults to testnet, because the failure mode of the wrong default matters: testnet on
     * mainnet infrastructure is a broken demo, mainnet on a testnet deployment moves real
     * money.
     */
    ALTANA_NETWORK: z.enum(['bnb-testnet', 'bnb']).default('bnb-testnet'),

    /**
     * Private key whose only job is topping up a user's wallet with native gas.
     *
     * A faucet, not an authority. It cannot grant a session, cannot revoke one and cannot
     * move anything from a user's account, because authority on an Altana wallet belongs to
     * the passkey in the user's device and this key is not it.
     *
     * The predecessor to this field was the admin signer for every session the marketplace
     * granted, which made the product custodial while its own copy promised the opposite.
     * The name changed with the semantics so nothing reintroduces the old behaviour by
     * reading a familiar variable.
     *
     * Empty disables sponsorship; hiring still works, the user funds their own gas.
     */
    AGENT_GAS_SPONSOR_PRIVATE_KEY: z
      .string()
      .regex(/^(0x[0-9a-fA-F]{64})?$/, 'expected a 0x-prefixed 32-byte private key, or empty')
      .default(''),

    /**
     * Native amount sent to a new user wallet, in wei.
     *
     * 0.005 BNB, and the previous 0.001 was the reason first hires failed with "an error
     * occurred while executing calls".
     *
     * The old figure was sized from on-chain gas alone: a grant/act/revoke lifecycle measured
     * 962,143 gas, about 0.0000481 BNB, and 0.001 was ~20x that. But the Altana relay charges a
     * separate fee per call, carried as `value` on each call in `wallet_prepareCalls`, and that
     * fee dominates: measured at ~0.000675 BNB per call from a real failing request. A grant is
     * two calls (~0.00135) and a commission is five (~0.0034), so 0.001 could not even cover a
     * single grant's fees, and the relay rejected the batch before anything executed.
     *
     * 0.005 clears a commission's fees plus its gas with headroom. A compromised sponsor key
     * still leaks only this much per fresh address, and at the sponsor's small float that is a
     * few dozen hires, which is what a demo and early use need.
     */
    AGENT_GAS_SPONSOR_AMOUNT_WEI: z
      .string()
      .regex(/^\d{1,30}$/)
      .default('5000000000000000'),

    /**
     * Per-address sponsorship ceiling in wei.
     *
     * Without this the sponsor endpoint is a drain: anyone can call it in a loop and empty
     * the key. Enforced against the address's current balance, so a wallet that already has
     * gas is refused rather than topped up again.
     *
     * 0.01, above the 0.005 grant so a wallet part-way through its funds is still topped up
     * for the next action rather than stranded just under the old ceiling.
     */
    AGENT_GAS_SPONSOR_MAX_BALANCE_WEI: z
      .string()
      .regex(/^\d{1,30}$/)
      .default('10000000000000000'),
  })
  .superRefine((env, ctx) => {
    // An "enabled" AI provider with no credentials is a silent 500 later, so
    // reject the combination here instead.
    if (env.AI_PROVIDER === 'openai-compatible' && env.AI_API_KEY.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_API_KEY'],
        message: 'required when AI_PROVIDER is "openai-compatible"',
      });
    }
    /*
     * Guards the one configuration mistake here that costs real money: running the mainnet
     * Altana network by accident. Going live has to be deliberate, so it requires
     * NODE_ENV=production as well, which a local or staging deployment will not have set.
     */
    if (env.ALTANA_NETWORK === 'bnb' && env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['ALTANA_NETWORK'],
        message:
          'mainnet hiring requires NODE_ENV=production. Real funds move on this network, so enabling it outside production is refused.',
      });
    }
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'wildcard origin is not allowed in production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    /**
     * Loopback locally, every interface in production.
     *
     * A single default cannot be right for both. `127.0.0.1` is correct on a laptop, where
     * binding every interface would expose a dev server to the network. It is always wrong in a
     * container: the platform reaches the process from outside, so a service on loopback is
     * unreachable no matter how healthy it is.
     *
     * This exists because the wrong half of that cost a deployment. The service built, validated
     * its environment, connected to Postgres and logged "Server listening at
     * http://127.0.0.1:10000", and the platform then spent five minutes reporting "No open ports
     * detected on 0.0.0.0" — a message that names neither the variable nor the process that is
     * plainly running. Nothing was broken except one default that had no business being the same
     * in both places.
     *
     * Still overridable, because a deployment that needs a specific interface should say so.
     */
    HOST: env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  }));

export type Env = z.infer<typeof envSchema>;

/**
 * Validates a raw environment bag. Exported separately from {@link loadEnv} so
 * tests can exercise the rules without mutating `process.env`.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const report = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${report}`);
  }

  return result.data;
}

let cached: Env | undefined;

/** Process-wide config. Parsed on first call, reused afterwards. */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}
