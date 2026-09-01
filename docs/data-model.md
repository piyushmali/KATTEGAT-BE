# Data model

Six tables. Defined in `src/infrastructure/database/schema.ts`, migrations in
`drizzle/`.

The brief listed fifteen candidate tables. Six are created because six have
behaviour; the rest are described at the bottom with the seam they would attach
to. An empty table is a claim the product makes and cannot honour.

Split by who owns the truth. Read from chain and mirrored here only so a page load
is not a registry decode: `agents`, `agent_reputation`, `agent_sessions`,
`agent_jobs`. Ours: `agent_categories`, which the classifier derives, and
`sync_state`. Where a mirrored table disagrees with chain, chain is right.

## `agents`

The normalised agent record: on-chain identity plus whatever the off-chain
registration file yielded.

| Column                 | Type             | Notes                                                               |
| ---------------------- | ---------------- | ------------------------------------------------------------------- |
| `id`                   | text PK          | `<chainId>:<agentId>` — see below                                   |
| `chain_id`             | integer          |                                                                     |
| `agent_id`             | bigint           | ERC-8004 agent id (on-chain `uint256`)                              |
| `owner_address`        | text             | ERC-721 owner                                                       |
| `wallet_address`       | text null        | From `getAgentWallet`; null when unset                              |
| `agent_uri`            | text null        | `tokenURI` — the registration file location                         |
| `name`                 | text             | Falls back to `Agent #<id>` when unresolved                         |
| `description`          | text null        |                                                                     |
| `protocol_tag`         | text             | Derived: `a2a` \| `mcp` \| `http-api` \| `custom` \| `unconfigured` |
| `trait_tags`           | text[]           | Derived, orthogonal                                                 |
| `capabilities`         | text[]           | Skills, domains and tags from the registration file                 |
| `raw_metadata`         | jsonb null       | The document as fetched                                             |
| `registered_at_block`  | bigint null      |                                                                     |
| `registered_at`        | timestamptz null | Block timestamp                                                     |
| `source`               | text             | Which integration produced the row                                  |
| `metadata_resolved_at`  | timestamptz null | **Null = registration file unresolved**                             |
| `metadata_attempts`     | integer          | Failed registration-file fetches; orders the backlog                |
| `metadata_attempted_at` | timestamptz null | When the last failed attempt happened                               |
| `last_synced_at`        | timestamptz      |                                                                     |
| `created_at`            | timestamptz      |                                                                     |
| `updated_at`            | timestamptz      |                                                                     |

Indexes: unique `(chain_id, agent_id)`, plus `owner_address`, `protocol_tag`,
`registered_at`, and a partial `(metadata_attempts, agent_id desc) where
metadata_resolved_at is null` serving the backlog pass.

**Why a composite text primary key.** An ERC-8004 agent id is only unique per chain,
and the registries are deployed at the same address on every mainnet — so `agent_id`
alone will collide the moment a second chain is indexed. One opaque string keeps
every route, cache key and foreign key simple, and it is human-readable in a log.

**Why `raw_metadata` is kept.** Storing the document as fetched means a mapper fix
can be replayed over existing rows without re-fetching several hundred URIs, some of
which will have rotated or gone offline.

**Why `metadata_resolved_at` is nullable rather than dropping the row.** A marketplace
that silently discards agents whose off-chain document is broken shows an incomplete
view of the ecosystem. The identity is on chain and verified; the profile is what is
missing. Nullable timestamp lets the API and UI say exactly that.

**Why the launch four are small, and why that is the honest number.** After `rules-v4`
the four BNB Agent Studio categories hold 500 agents: grid-trading 120, yield 239,
rebalancing 97, health-factor 44. A further 250 sit in `uncategorized` carrying a single
keyword each, recorded as `weak-signal:<category>`. Clearing them would mean dropping
`PRIMARY_THRESHOLD` to 1, which turns one passing mention of "portfolio" or "yield" into a
category assignment. A wrong category is worse than none, because a visitor cannot tell it
is wrong, so the threshold stays and the weak signals stay visible.

**Why a row exists for agents with no feedback.** The reputation sweep records every
agent it reads, including the ones with nothing. "Swept, no feedback" is a finding;
"no row" is an admission that nobody looked, and the UI needs to tell them apart. Before
the sweep, reputation was only read when a visitor opened a profile, which left 130 rows
out of 317,476 and meant the `reputation` and `feedback` sorts ranked a set of 130 while
`nulls last` parked everything else behind them.

**Why `metadata_attempts` exists.** The backlog pass selects unresolved agents and
fetches their registration files. Ordered by ascending `agent_id`, as it originally was,
it kept re-selecting the same head of the queue, and the low ids hold a wall of
permanently broken URIs: one serves an HTML page, another a Google Apps Script redirect.
Measured on the live registry, 479 of 480 fetches in a pass failed and the backlog never
moved. Ordering by attempt count first lets repeat failures sink while agents nobody has
tried yet get reached; the same pass then resolved 59 of 60. Counted rather than flagged,
so one bad night does not permanently write an agent off.

Failures update this column only. `metadata_resolved_at` stays null, because marking a
failure resolved would drop the row out of the backlog and lose the retry.

**`agent_id` precision.** Stored as `bigint` read back as a JS number, exact to 2^53.
ERC-8004 ids are minted from a sequential counter, so the real ceiling is far away.
If ids ever become hash-derived, switch to `numeric` with string mode — flagged in a
`ponytail:` comment at the column.

## `agent_categories`

Classification output. One row per `(agent, category)`.

| Column               | Type        | Notes                                       |
| -------------------- | ----------- | ------------------------------------------- |
| `agent_id`           | text FK     | → `agents.id`, cascade delete               |
| `category`           | text        | Part of the composite primary key           |
| `confidence`         | real        | 0–1, heuristic — not a probability          |
| `is_primary`         | boolean     | Exactly one true per agent                  |
| `signals`            | text[]      | Why it matched, e.g. `capability:rebalance` |
| `classifier_version` | text        | e.g. `rules-v1`                             |
| `classified_at`      | timestamptz |                                             |

Indexes: `(category, confidence)`, `(is_primary, category)`.

**Why a separate table rather than a column on `agents`.** An agent legitimately
spans categories — a treasury manager rebalances _and_ chases yield — and each
assignment carries its own confidence and evidence. A single column would force a
lossy choice at write time.

**Why `signals` is persisted.** It is what makes the "Why this category?" panel
truthful instead of an unexplained score. Recomputing it at read time would mean
re-running the classifier on every request.

**Ingestion replaces rather than merges** these rows. The classifier is
deterministic, so its current output is the whole truth; merging would strand
assignments from an older taxonomy version on the record forever.

## `agent_reputation`

Snapshot of the ERC-8004 `ReputationRegistry`, one row per agent.

| Column             | Type         | Notes                                    |
| ------------------ | ------------ | ---------------------------------------- |
| `agent_id`         | text PK FK   | → `agents.id`, cascade delete            |
| `feedback_count`   | integer      | Non-revoked entries in the summary       |
| `client_count`     | integer      | Distinct clients — the anti-sybil signal |
| `summary_value`    | bigint null  | Fixed-point average as returned          |
| `summary_decimals` | integer null | Its exponent                             |
| `source`           | text         |                                          |
| `computed_at`      | timestamptz  |                                          |

**Why both halves of the fixed-point pair are stored.** `getSummary` returns
`(count, summaryValue, summaryValueDecimals)`; the real score is
`summaryValue / 10 ** summaryValueDecimals`. Collapsing that to a float at write time
bakes in a rounding decision the API consumer cannot undo, and dropping the exponent
would render a 4.25 rating as 425.

**Null vs zero.** No feedback leaves both columns null, and the API reports
`score: null`. An agent nobody has rated and an agent rated badly are different
claims, and the distinction survives to the UI.

This table is a cache. `GET /agents/:id/reputation` reads the registry live and
refreshes it, so a later failure has something recent to fall back to.

## `agent_sessions`

Authority a user granted an agent through an Altana session key. A local index of
what the public Keystore already records, so listing a user's grants does not mean
decoding a registry on every page load.

| Column            | Type        | Notes                                                        |
| ----------------- | ----------- | ------------------------------------------------------------ |
| `public_key`      | text PK     | The session key. Already the chain's identifier for it        |
| `agent_id`        | text FK     | cascade delete                                               |
| `wallet_address`  | text        | The account the session may act on                           |
| `spend_limit_wei` | text        | Ceiling in wei. Text: only displayed and compared, never summed |
| `spend_period`    | text        | Rolling window the ceiling applies over                      |
| `allowed_calls`   | text[]      | Permitted targets as granted. Empty means no call restriction |
| `expires_at`      | timestamptz |                                                              |
| `granted_tx_hash` | text        | When the relay surfaced a receipt                            |
| `revoked_at`      | timestamptz | Null while live                                              |
| `chain_id`        | integer     | So a mainnet grant is never rendered as weightily as testnet |

Nothing here is enforced by us. The Altana account contract holds the real
permissions; a call outside them reverts at validation time. Which is why the API
derives `status` from a Keystore read rather than from `revoked_at`: a user can
revoke through another app, or through the Altana MCP server in Claude, and never
touch KATTEGAT. Deriving status from our own column would show that session as
live indefinitely.

The honest failure mode is being *behind*, never being wrong in a way that
matters. A session missing here is still enforced on chain.

## `sync_state`

Ingestion cursor, one row per `(chain, registry)`.

| Column                 | Type             | Notes                               |
| ---------------------- | ---------------- | ----------------------------------- |
| `id`                   | text PK          | e.g. `56:identity`                  |
| `last_block`           | bigint           | Last block **successfully** scanned |
| `last_run_at`          | timestamptz null |                                     |
| `last_success_at`      | timestamptz null |                                     |
| `last_error`           | text null        | Surfaced by `/health`               |
| `consecutive_failures` | integer          |                                     |

Required, not optional. The identity registry is not `ERC721Enumerable` —
`totalSupply()` reverts — so agents can only be found by replaying `Registered`
logs, and incremental replay needs a durable marker.

`last_block` is the last block actually processed, never the chain head. A failed
`eth_getLogs` window stops the scan; recording the head would permanently skip every
agent in the unread range.

`last_error` and `consecutive_failures` exist so `/health` can report a degraded
integration. Without them a sync could fail for hours while health looked perfect.

## `agent_jobs`

ERC-8183 jobs read from the AgenticCommerce kernel: escrowed work an agent was
actually paid for. A mirror, never a source of truth — if this disagrees with
chain, chain is right.

| Column              | Type            | Notes                                                          |
| ------------------- | --------------- | -------------------------------------------------------------- |
| `id`                | text PK         | `<chainId>:<jobId>`                                            |
| `chain_id`          | integer         | See the two-chain note below                                   |
| `job_id`            | bigint          | Kernel job id, 1-indexed from `jobCounter`                     |
| `client_address`    | text            | Who paid. Lowercased                                           |
| `provider_address`  | text            | Who was hired. An address, hence nullable `agent_id`           |
| `evaluator_address` | text            | Who alone may mark the job complete                            |
| `budget_raw`        | numeric(78,0)   | Raw $U units. `numeric` so totals sum exactly in Postgres      |
| `status`            | integer         | 0 OPEN, 1 FUNDED, 2 SUBMITTED, 3 COMPLETED, 4 REJECTED, 5 EXPIRED |
| `description`       | text            | The task as written on chain, up to 4096 bytes                 |
| `expired_at`        | timestamptz     |                                                                |
| `submitted_at`      | timestamptz     | Null until the provider submits                                |
| `deliverable_hash`  | text            | The provider's commitment. Null while unset                    |
| `agent_id`          | text FK         | `on delete set null`. Null unless attribution resolves          |
| `last_synced_at`    | timestamptz     |                                                                |

Indexes: unique `(chain_id, job_id)`, `(agent_id, job_id desc)` for the hot
per-agent read, `provider_address` for re-attribution, and a partial
`(chain_id, job_id) where status < 3` serving the refresh pass — terminal jobs
leave that index instead of being carried in it forever.

**Attribution is deliberately incomplete.** The kernel names a provider address,
not an agent id, and addresses are reused: one address in a sampled window is the
wallet of 768 different agents. So `agent_id` is set only when the provider
resolves to exactly one indexed agent. Anything else stays null and still counts
as real escrow activity, just not as any particular agent's record. Attribution
recomputes in both directions each pass, because `setAgentWallet` can make a
previously unique address ambiguous and a stale link would show one agent's
history on another's page.

**Two chains live here.** Indexing writes the chain the catalogue was built from;
a hire recorded through the hiring module writes the chain the user's session is
on. In production they are the same and a real hire becomes part of the agent's
record. On testnet they are not, so every evidence query is scoped to the registry
chain — a rehearsal against a kernel where the agent is not registered must not
appear as delivery history.

There is no `deliverable_url` column. One was built and removed: the only
mechanism for publishing that link resolved nothing across 16 submitted mainnet
jobs spread over all of job history, and a permanently null column sitting beside
real figures reads as evidence.

## Relationships

```
agents 1──n agent_categories     (cascade delete)
agents 1──1 agent_reputation     (cascade delete)
agents 1──n agent_sessions       (cascade delete)
agents 1──n agent_jobs           (set null on delete)
sync_state                        (independent, keyed by chain:registry)
```

Categories, reputation and sessions cascade: an agent removed from the index
should not leave orphaned rows skewing the counts on `/api/v1/categories`.

`agent_jobs` does not cascade, on purpose. A job existed on chain whether or not
we can attribute it, so removing an agent unattributes its jobs rather than
deleting facts we do not own.

## Deferred tables

Not created, with the seam each would attach to:

| Table                                                     | Waiting on                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agent_permissions`                                       | Per-call permission detail beyond the allowlist `agent_sessions` already stores.                                             |
| `transactions`                                            | Agents executing on a user's behalf.                                                                                        |
| `users`, `saved_agents`                                   | Authentication, which needs a user-owned resource first.                                                                    |
| `comparisons`                                             | Only if comparisons become shareable and need an id.                                                                        |
| `agent_feedback`                                          | Individual entries; only the aggregate is used today. `readAllFeedback` is available when the UI needs the list.            |
| `agent_performance`, `agent_activity`                     | A real measured source. ERC-8004 exposes no performance metric, and inventing one is explicitly out of scope.               |
| `agent_protocols`, `agent_assets`, `agent_hiring_options` | Normalising arrays that are currently `text[]` columns — worth it when they need their own attributes or joins, not before. |

## Migrations

```bash
pnpm db:generate   # after editing schema.ts
pnpm db:migrate    # apply
```

Migrations run as a separate command, never on server boot, so a rolling deploy
cannot have two instances migrating concurrently.
