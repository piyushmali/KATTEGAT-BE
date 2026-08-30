# Data model

Four tables. Defined in `src/infrastructure/database/schema.ts`, migrations in
`drizzle/`.

The brief listed fifteen candidate tables. Four are created because four have MVP
behaviour; the rest are described at the bottom with the seam they would attach to.
An empty table is a claim the product makes and cannot honour.

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

## Relationships

```
agents 1──n agent_categories     (cascade delete)
agents 1──1 agent_reputation     (cascade delete)
sync_state                        (independent, keyed by chain:registry)
```

Both child tables cascade: an agent removed from the index should not leave orphaned
categories skewing the counts on `/api/v1/categories`.

## Deferred tables

Not created, with the seam each would attach to:

| Table                                                     | Waiting on                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agent_sessions`, `agent_permissions`                     | Hiring. `agents.wallet_address` is already captured.                                                                        |
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
