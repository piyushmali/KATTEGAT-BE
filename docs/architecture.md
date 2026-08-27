# Architecture

## The problem this service solves

ERC-8004 gives every agent a portable on-chain identity and a place to accumulate
reputation. It does not tell a user which agent to hire. The registries describe
*protocols* and *traits*; a marketplace needs to answer "what does this do, can I
trust it, and how do I compare it to the alternative".

Everything below exists to turn registry data into that answer, and to make each
step's reasoning inspectable rather than magic.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ app/          HTTP assembly, error handling, composition │
├──────────────────────────────────────────────────────────┤
│ modules/      domain logic — one folder per concern      │
├──────────────────────────────────────────────────────────┤
│ integrations/ adapters to the outside world              │
├──────────────────────────────────────────────────────────┤
│ infrastructure/  database, logging                       │
└──────────────────────────────────────────────────────────┘
                  shared/  error model, wire envelopes
```

**Dependencies point inward.** `integrations/` imports domain types from
`modules/agents/agent.types.ts` and produces domain models; nothing in `modules/`
imports a provider's response shape. That is what makes the ERC-8004 Explorer
replaceable without touching marketplace logic.

`app/server.ts` is the only composition root. Every dependency is constructed there
and injected, so no module reaches for a global and each is testable in isolation.

## Domain modules

| Module           | Owns                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `agents`         | The agent aggregate: identity, profile, list/detail queries        |
| `categories`     | The taxonomy surface and its counts                               |
| `classification` | The category vocabulary and the rules that assign it              |
| `reputation`     | Live registry reads and their provenance                          |
| `search`         | Natural-language query → structured filters                       |
| `ingestion`      | The fetch → validate → normalise → classify → persist pipeline    |

Each module holds its own `routes`, `service`, `repository` and `schema`. A module
never reaches into another module's repository: `categories` counts agents through
its own `category.repository.ts`, even though it reads the same tables, because a
shared repository is how two domains end up coupled through SQL.

### Why these boundaries and not one `Agent` service

The four concerns that make up an agent have different owners and different
freshness contracts, and collapsing them would lose that:

- **Identity** is on-chain and immutable once registered. Always available.
- **Profile** is an off-chain document that may be missing, malformed or moved. It
  fails independently, so `metadata_resolved_at` is nullable and the UI renders a
  partial state rather than hiding the agent.
- **Categories** are *derived by us*. They carry a confidence and the signals that
  produced them, and they change when the taxonomy changes.
- **Reputation** is on-chain but moves continuously. Browsing serves a snapshot;
  the detail page reads live.

## Vocabulary ownership

Two enums are load-bearing, and each has exactly one definition:

- `AGENT_CATEGORIES` lives in `modules/classification/taxonomy.ts`, because
  classification derives it. The Drizzle column, the Zod wire enums, the classifier
  and the search parser all import from there.
- `PROTOCOL_TAGS` lives in `integrations/erc8004/registration-file.ts`, because that
  is where the tag is derived from an agent's declared services.

Neither is restated in the database schema. Both columns are plain `text`, so adding
a fifth category is a one-line change to the taxonomy with no migration.

## Request flow

```
HTTP request
  → Fastify (Zod validates params/query against the module's schema)
  → module routes  (one-line delegation, no logic)
  → module service (wire ⇄ domain translation, orchestration)
  → module repository (SQL)   or   integrations/ (chain, HTTP)
  → response serialised through the same Zod schema
```

Response serialisation is validated too. If the service returns a shape the contract
does not allow, that is our bug: it is logged loudly with the request id and the
caller gets a generic 500 rather than a malformed body.

## Ingestion flow

The identity registry is not enumerable, so discovery is log replay:

```
resolve start block  (stored cursor, clamped to what the RPC will serve)
  → eth_getLogs in windows for `Registered`
  → per agent: resolve agentURI → fetch + validate registration file
  → derive protocol tag, trait tags, capabilities
  → classify  → category + confidence + signals
  → read reputation (budgeted: 2 RPC calls each)
  → upsert in one transaction per batch
  → advance cursor to the last block actually processed
```

Two details that matter:

- **The cursor advances to the last *successfully scanned* block, not the chain
  head.** A window that fails stops the scan; recording the head would silently
  skip every agent in the unread range.
- **A broken registration file degrades one agent, not the run.** The agent is still
  persisted — its identity is verified on chain — with `metadata_resolved_at` null.

Failures are written to `sync_state.last_error` and `consecutive_failures` so
`/health` can report a stale catalogue instead of claiming everything is fine.

## Classification

Deterministic rules over the agent's declared capabilities, name and description.
Not a model call, for three reasons: the same agent must classify identically on
every sync or the marketplace reshuffles between page loads; every assignment has to
be explainable in the UI; and a per-agent model call adds cost and latency to what is
fundamentally a keyword decision.

Every assignment ships the signals that produced it — `capability:rebalance`,
`phrase:health factor` — which is what makes the "Why this category?" panel truthful.
An agent nothing matches is explicitly `uncategorized` rather than forced into the
nearest bucket, so gaps in the taxonomy stay visible.

## Reputation

KATTEGAT does not compute a score. `ReputationRegistry.getSummary` returns the
average of non-revoked client feedback as `(count, summaryValue, summaryDecimals)`,
and both halves are stored and forwarded so a client can render the exact on-chain
figure. The real value is `summaryValue / 10 ** summaryDecimals` — ignoring the
exponent would display a 4.25 rating as 425.

Two behaviours of the registry drive the implementation:

- `getSummary` **reverts** on an empty client list, so `getClients` must be called
  first. An agent with no feedback is answered without a second call.
- No feedback yields `score: null`, never `0`. Absence of evidence and a bad score
  are different claims and stay distinguishable all the way to the UI.

The live endpoint falls back to the stored snapshot when the registry is unreachable,
reports which it served in `origin`, and explains itself in `notes`.

## Search

The deterministic parser resolves a query into the same filter vocabulary
`GET /agents` accepts, reusing the classification taxonomy so "what is this agent?"
and "what is this user asking for?" can never drift apart. The interpretation is
returned with the results: `meta.interpretation.filters` is the query that actually
ran and `explanation` says how it was derived, so a user can correct a misreading.

A model is consulted for exactly one thing — choosing a category when the rules find
none — only when a provider is configured, and its answer is validated against the
known category list before use. If it fails, times out or returns nonsense, the
deterministic result stands.

Preferences the data cannot support are not invented. "Conservative" becomes "rank by
recorded feedback and exclude agents with unresolved metadata", because KATTEGAT has
no risk metric and pretending otherwise would be a fabricated number.

## Security posture

- Every request body, query and param is validated by Zod before a handler runs.
- Registration files come from URIs third parties control on chain, so fetching them
  is an SSRF boundary: scheme allowlist (`ipfs://`, `https://`, `data:`), private and
  link-local address blocking, redirect refusal, size cap and timeout.
- Rate limiting is on by default. The resource being protected is the upstream RPC
  and IPFS quota this service fronts.
- Error responses never carry provider internals. Only errors raised deliberately
  have their message forwarded; anything else becomes a generic 500 and the cause
  goes to the log with the request id.
- The backend holds no private key and signs nothing. Every chain call is a read.

There is no authentication, because there are no user-owned resources yet. That
changes the day hiring lands — see below.

## Extension points

These are real product concerns with no MVP behaviour yet. They are documented here
rather than created as empty modules.

**Hiring, sessions and spend permissions.** A new `modules/hiring` module plus
`agent_sessions` and `agent_permissions` tables. The seam already exists: every agent
carries `walletAddress` from `getAgentWallet`. The rule this must not break is that
granting authority is an explicit, scoped step — spend cap, expiry and revocation
visible before anything is signed. A listed agent must never obtain open-ended access
to user funds.

**Partner integrations.** Each becomes a new adapter under `integrations/`:

- *Altana* — agent-controlled wallets, session limits, revocation. Plugs in beside
  the hiring module; `AgentSource` is unaffected.
- *PancakeSwap* — pool and yield data to enrich yield-optimization agents. An
  enrichment source like `explorer-client.ts`, never a base data path.
- *TermiX* — agent-versus-manual execution comparison. Note that TermiX is currently
  the dominant registrar on BSC ERC-8004 (see `docs/integrations.md`), so this is the
  highest-signal partner surface.

**Ranking.** Sorting today is by one field. Explainable multi-factor ranking would
be a `modules/ranking` service composing category relevance, reputation, track record
and recency — and, like classification, it must emit the reasons alongside the score.
An unexplained "AI score" is explicitly not wanted.

**Comparison.** Currently a client-side concern. It only needs a module if
comparisons become shareable, which means a `comparisons` table and an id.
