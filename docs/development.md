# Development

## Prerequisites

- Node.js 22+ (developed on 24 — see `.nvmrc`)
- pnpm 10+
- PostgreSQL 14+

## First run

```bash
pnpm install
cp .env.example .env
createdb kattegat
pnpm db:migrate
pnpm sync:agents        # populate the catalogue from BNB Smart Chain
pnpm dev
```

`http://127.0.0.1:4000/docs` for Swagger UI, `/health` for status.

The defaults in `.env.example` work as-is: only `DATABASE_URL` usually needs editing,
and the RPC endpoints and registry addresses are the values this project was verified
against.

## Verifying the chain integration

```bash
pnpm verify:chain
```

No database needed. Reads the registry name, probes the servable log window, scans
`Registered` logs, resolves registration files, classifies what it found and reads one
agent's reputation. Exits non-zero on failure, so it works as a CI smoke check.

Use it whenever the registry addresses, RPC configuration or ABI subset change.

## Ingestion

```bash
pnpm sync:agents                        # incremental — new Registered logs
pnpm sync:agents --full                 # re-scan the widest log window available
pnpm sync:agents --backfill             # walk agent ids — reaches the whole registry
pnpm sync:agents --backfill --limit 400
pnpm sync:agents --backfill --loop      # repeat until the registry is exhausted
```

**Which one to run.** Incremental replays logs and is bounded by the endpoint's log
retention — roughly two hours on any free tier, so it only ever sees recent
registrations. Backfill walks agent ids with plain `eth_call`, which has no retention
limit, and is the only way to reach the registry's ~310k historical agents. Run
`--backfill --loop` once to build a catalogue, then plain `pnpm sync:agents` on a
schedule to stay current.

Backfill is resumable under its own cursor, so interrupting `--loop` loses at most one
batch. Its cost is metadata fetching, not RPC: expect a few hundred agents per minute.

A process rather than an in-server interval: ingestion and serving have different
failure modes and scaling needs, and a cron entry is easier to observe than a
background timer.

Expect roughly 240 agents and ~40 s on a default 8,000-block window. Reputation reads
are budgeted per run (60 by default, 2 RPC calls each); agents beyond the budget are
persisted without a reputation snapshot and picked up next run.

If the catalogue looks empty, check `/health` — `checks.ingestion` reports the last
successful run, the cursor and any error.

## Conventions

**Imports use relative paths with an explicit `.js` extension.**

```ts
import { loadEnv } from '../config/env.js';   // correct
import { loadEnv } from '@/config/env';       // wrong — breaks at runtime
```

The build is NodeNext ESM and `tsc` does not rewrite specifiers, so a path alias
compiles and then fails at runtime. **The frontend uses the opposite convention** —
bare specifiers and `@/` — so do not copy an import style between the repos.

**Each domain module owns its own routes, service, repository and schema.** A module
must not use another module's repository. If two modules need the same query, each
owns its own; a shared repository is how domains get coupled through SQL.

**Dependencies point inward.** `integrations/` may import domain types from
`modules/`, never the reverse. Nothing in `modules/` should know a provider's JSON
shape.

**Zod schemas are the single source of truth for the wire.** Fastify validates
requests and serialises responses from them, and OpenAPI is generated from them. Do
not hand-write a response type.

**Wire is `snake_case`, internals are `camelCase`.** Translation happens in the
service layer (`agent.mapper.ts` for agents), so renaming an internal field cannot
silently break the frontend.

**Route handlers are one line.** Validate declaratively, delegate to the service. Any
logic in a handler belongs in the service.

## Adding an endpoint

1. Add request/response schemas to the module's `*.schema.ts`.
2. Add the method to the service interface and implement it.
3. Add SQL to the module's repository if needed.
4. Register the route in `*.routes.ts` with `operationId`, `tags`, `summary` and every
   response code it can return.
5. If it is a new domain, create the module folder and register its routes in
   `app/server.ts`.
6. Mirror the response schema in `KATTEGAT-FE/src/lib/api/contract.ts` and add a live
   contract test there.

## Adding a category

Append a `CategoryRule` to `src/modules/classification/taxonomy.ts`. That is the only
change: the database column is plain `text`, and the Zod enums, classifier and search
parser all derive from `AGENT_CATEGORIES` in that file. No migration.

Add cases to `classifier.test.ts` — including a counter-example that must *not* match.

## Testing

```bash
pnpm test          # all
pnpm test:watch
```

`src/config/env.test.ts` and the classification and search specs need nothing external.
`src/app/api.test.ts` needs a reachable `DATABASE_URL` with migrations applied; it
drives the real HTTP surface through `app.inject()` against real PostgreSQL, because
the things most likely to break are the SQL and the response contract and a mocked
database tests neither.

Fixtures use chain id `31337` so they cannot collide with indexed BSC data (chain 56),
and are removed afterwards regardless of outcome.

Test files run sequentially (`fileParallelism: false`) because the API suite shares one
database.

## Before pushing

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

All four must be clean.

## Troubleshooting

**`eth_getLogs` fails / no agents found.** Most public BSC endpoints do not support
`eth_getLogs`. Use `bsc-rpc.publicnode.com` or `bsc.rpc.blxrbdn.com`. Full list of what
does and does not work in [`integrations.md`](integrations.md).

**Sync reports `clamped: true`.** The requested range predates the endpoint's log
retention (~8,000 blocks on free tiers). Expected. Point `BSC_RPC_URL` at an
archive-capable provider and raise `ERC8004_MAX_LOOKBACK_BLOCKS` to reach further back.

**Agents appear with `Agent #123` names and no description.** Their registration file
did not resolve — `metadata_resolved_at` is null. The identity is still verified on
chain. Run with `LOG_LEVEL=debug` to see the per-agent reason.

**`Invalid environment configuration` on startup.** Intentional. The report names each
invalid variable; fix them in `.env`. Nothing starts with bad config.

**`drizzle-kit` cannot find `DATABASE_URL`.** It does not accept Node's `--env-file`
flag; `drizzle.config.ts` loads `.env` itself via `process.loadEnvFile`. Confirm the
file exists and the variable is set.

**The server connects to the wrong database, or `/health` returns 503 with
`database "…" does not exist`.** Node's `--env-file` does **not** override variables
that are already set in the environment, so an exported `DATABASE_URL` silently wins
over `.env` — and nothing warns you. Check with `echo $DATABASE_URL`, and start the
server in a clean environment if something stale is exported:

```bash
env -u DATABASE_URL pnpm dev
```

This is easy to hit after running a one-off command with an inline
`DATABASE_URL=… pnpm …` in a shell you keep using.

**Rate limited in development.** The limit is 1000/min in development, 120/min in
production. `/health` is exempt.
