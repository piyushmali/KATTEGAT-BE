# KATTEGAT — Backend

**The home of autonomous agents.**

Discovery, evaluation and trust layer for autonomous agents on BNB Smart Chain. This
service indexes agents from the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
registries, works out what each one actually does, and serves it to the frontend
with the evidence behind every claim.

Frontend repository: [KATTEGAT-FE](https://github.com/piyushmali/KATTEGAT-FE)

---

## What it does

```
ERC-8004 registries (BNB Smart Chain)
        ↓  Registered event logs
   chain reader  ──────────────────────►  registration files (IPFS / HTTPS)
        ↓                                          ↓
   normalise  ◄─────────────────────────────  validate
        ↓
   classify   (derive marketplace category + the signals that produced it)
        ↓
   persist    (PostgreSQL)
        ↓
   REST API   ───────────────────────────►  KATTEGAT-FE
```

Three facts shape the whole design, all verified against BSC mainnet rather than
assumed:

1. **ERC-8004 has no category field.** The registries describe *protocols* (`a2a`,
   `mcp`, `http-api`) and *traits* (`x402-paid`, `multichain`), not what an agent
   does for a user. Deriving the marketplace category is KATTEGAT's own work — see
   [`docs/architecture.md`](docs/architecture.md).
2. **The identity registry is not `ERC721Enumerable`.** `totalSupply()` reverts, so
   agents can only be discovered by replaying `Registered` logs.
3. **Reputation already exists on chain and is not ours to invent.** The
   `ReputationRegistry` returns an average of client feedback as a fixed-point
   integer. KATTEGAT stores and forwards both halves and never fabricates a score.

## Tech stack

| Concern    | Choice                                    |
| ---------- | ----------------------------------------- |
| Runtime    | Node.js 22+ (developed on 24), TypeScript 6 strict |
| HTTP       | Fastify 5 + `fastify-type-provider-zod`   |
| Validation | Zod 4 (requests, responses, env, external documents) |
| Database   | PostgreSQL + Drizzle ORM (`postgres.js` driver) |
| Chain      | viem 2 (read-only)                        |
| Logging    | pino                                      |
| Tests      | Vitest                                    |
| Docs       | `@fastify/swagger` → OpenAPI 3.0.3 at `/docs` |

No Redis, no queue, no worker pool. Ingestion is a bounded log scan run from the
CLI; adding a broker would be operational surface with no product benefit. See
[`docs/decisions.md`](docs/decisions.md).

## Quick start

Requires Node 22+, pnpm, and a PostgreSQL instance.

```bash
pnpm install
cp .env.example .env          # defaults work for local development
createdb kattegat             # or point DATABASE_URL at an existing database
pnpm db:migrate               # apply schema
pnpm verify:chain             # optional: prove the chain integration works
pnpm sync:agents              # index agents from BNB Smart Chain
pnpm dev                      # http://127.0.0.1:4000  (docs at /docs)
```

`pnpm sync:agents` is what populates the marketplace. Without it the API is healthy
but the catalogue is empty, and `/discover` in the frontend will say so.

## Commands

| Command             | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `pnpm dev`          | Dev server with reload                                    |
| `pnpm build`        | Compile to `dist/`                                        |
| `pnpm start`        | Run the compiled server                                   |
| `pnpm typecheck`    | `tsc --noEmit`                                            |
| `pnpm lint`         | ESLint (type-aware)                                       |
| `pnpm test`         | Vitest — unit plus API integration tests                  |
| `pnpm db:generate`  | Generate a migration from the schema                      |
| `pnpm db:migrate`   | Apply pending migrations                                  |
| `pnpm db:studio`    | Drizzle Studio                                            |
| `pnpm sync:agents`  | Ingest agents (`--full` re-scans the widest window)       |
| `pnpm verify:chain` | Live end-to-end check of the ERC-8004 integration         |

## API

Six endpoints. Full reference in [`docs/api.md`](docs/api.md); the live OpenAPI
document is at `/docs/json` and Swagger UI at `/docs`.

```
GET /health                              service + ingestion freshness
GET /api/v1/agents                       search / filter / paginate
GET /api/v1/agents/:id                   one agent
GET /api/v1/agents/:id/reputation        live registry read, with provenance
GET /api/v1/categories                   taxonomy with counts
GET /api/v1/search?q=...                 natural-language search
```

Errors share one shape, so the frontend can branch on `code` rather than parse prose:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "No agent with id \"56:1\" has been indexed.",
    "request_id": "0f8c…"
  }
}
```

## Project structure

```
src/
├── app/              server assembly, error handler, health, composition root
├── config/           env contract, validated at startup
├── infrastructure/   database client + schema, logging
├── integrations/     outward adapters (ERC-8004 chain reader, explorer, AI)
├── modules/          domain modules: agents, categories, reputation, search,
│                     classification, ingestion
└── shared/           error model, cross-cutting wire envelopes
```

Each domain module owns its own routes, service, repository and schema. Dependencies
point inward: adapters in `integrations/` depend on domain types, never the reverse.
[`docs/architecture.md`](docs/architecture.md) explains the boundaries and why the
category and protocol vocabularies live where they do.

## Environment

Every variable is documented in [`.env.example`](.env.example) and validated by
`src/config/env.ts` at startup — a bad value stops the process with a readable
report instead of failing on the first request that needs it.

Only `DATABASE_URL` is genuinely required. The defaults for the RPC endpoints and
registry addresses are the ones this project was verified against.

Two constraints worth knowing before you change the RPC settings:

- **Most public BSC endpoints cannot serve `eth_getLogs`.** `bsc-dataseed*`,
  `meowrpc`, `1rpc.io` and others either reject it or cap the range at 25–50
  blocks. Verified working: `bsc-rpc.publicnode.com`, `bsc.rpc.blxrbdn.com`.
- **Free endpoints keep only a short log history** — measured at roughly 8k blocks.
  Full historical backfill needs an archive-capable provider. Details and the
  fallback strategy are in [`docs/integrations.md`](docs/integrations.md).

Never commit `.env`; it is gitignored and only `.env.example` is tracked.

## Testing

```bash
pnpm test
```

Unit tests cover the pieces that would fail silently — classification and search
intent — and `src/app/api.test.ts` exercises the real HTTP surface against a real
PostgreSQL through `app.inject()`. It seeds fixtures on chain id `31337` so they
cannot collide with indexed BSC data, and removes them afterwards.

The API tests need a reachable `DATABASE_URL` with migrations applied. Everything
else runs with no external dependency.

## Documentation

| Document                                     | Contents                                            |
| -------------------------------------------- | --------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md) | Layers, domain boundaries, request and ingestion flow |
| [`docs/api.md`](docs/api.md)                 | Endpoint reference, filters, error codes             |
| [`docs/data-model.md`](docs/data-model.md)   | Tables, why there are only four, what was deferred   |
| [`docs/integrations.md`](docs/integrations.md) | ERC-8004, RPC limits, fallbacks, partner extension points |
| [`docs/decisions.md`](docs/decisions.md)     | Decisions taken and the reasoning, including rejected options |
| [`docs/development.md`](docs/development.md) | Local setup, conventions, troubleshooting            |

## Status

Bootstrap complete and verified against BSC mainnet. Working: ingestion,
classification, discovery, filtering, live reputation, natural-language search,
OpenAPI, health reporting.

Not built yet, and deliberately not stubbed: hiring, agent sessions and spend
permissions, comparison persistence, and user accounts. The extension points for
each are described in `docs/architecture.md` rather than left as empty folders.
