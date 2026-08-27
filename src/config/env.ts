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
    HOST: z.string().min(1).default('127.0.0.1'),
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
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'wildcard origin is not allowed in production',
      });
    }
  });

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
