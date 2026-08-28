# Decisions

Why the code looks like it does. Where a reasonable alternative was rejected, the
reason is recorded — including the cases where the first attempt was wrong.

---

## 1. Read the registries directly; treat the Explorer API as optional

**Decision.** Primary data comes from `eth_getLogs` and `eth_call` against the
ERC-8004 registries on BNB Smart Chain. The QuickNode Explorer API is optional
enrichment, disabled by default.

**Why.** The Explorer is paywalled per request via x402 (~$0.001 USDC on Base) with
no API key. A marketplace whose every page load depends on a funded signer is not
demo-reliable, and the registries are free and authoritative anyway.

**Cost.** More work: log windowing, registration-file resolution, fixed-point
decoding. Accepted — it removes the only hard external dependency.

---

## 2. Classification is deterministic rules, not a model

**Decision.** `modules/classification` scores declared capabilities, name and
description against a rule table and emits the matched signals.

**Why.** Three reasons, in order: the same agent must classify identically on every
sync or the marketplace reshuffles between page loads; every assignment must be
explainable in the UI, and "the model said so" is not an explanation; and a per-agent
model call adds cost and latency to what is fundamentally a keyword decision.

**Rejected.** LLM classification of every agent. Non-deterministic ordering in a
trust product, unexplainable, and directly against the brief's own guidance not to
spend a model call on a deterministic filter.

**Consequence.** The rules cannot categorise agents outside the four launch
categories, and they say so — `uncategorized` with `no-signal-match` rather than a
forced guess. See decision 11.

---

## 3. Never invent a reputation score

**Decision.** Store and forward `getSummary`'s `(count, summaryValue,
summaryValueDecimals)` unchanged. `score` is the decoded convenience value; no
KATTEGAT-computed score exists.

**Why.** The registry already carries client feedback, and the Explorer already
publishes explainable sub-scores. Adding a proprietary number on top would be exactly
the black-box "AI score" the brief rules out, and it would be unfalsifiable.

**Detail that matters.** `score: null` means no feedback exists. It is never coerced
to `0`, because "nobody has rated this" and "rated badly" are different claims and a
hiring decision turns on the difference.

---

## 4. Four tables, not fifteen

**Decision.** `agents`, `agent_categories`, `agent_reputation`, `sync_state`.

**Why.** Each has MVP behaviour. An empty `agent_performance` table is a promise the
product cannot keep, and ERC-8004 exposes no performance metric to fill it with.
Deferred tables and their attachment points are listed in
[`data-model.md`](data-model.md).

---

## 5. No Redis, no queue, no worker pool

**Decision.** Ingestion is one sequential pass run from a CLI. PostgreSQL is the only
datastore.

**Why.** The work is a bounded log scan against one chain. A broker would add
operational surface, another failure mode and another thing to explain, for no product
gain. The abstraction that *does* matter is already present: ingestion depends on
`AgentSource` and `AgentRepository`, so a second chain is a new implementation rather
than a rewrite.

**Note.** PostgreSQL persistence is not premature caching here — it is cost control
for a paywalled upstream and the only way to serve a catalogue the free RPC window
cannot re-read.

---

## 6. TypeScript 6.0.3, not 7.0.2

**Decision.** Pin TypeScript 6 in both repos.

**Why.** TypeScript 7 (the Go port, ~10x faster) is stable, but
`typescript-eslint@8.68.0` declares `typescript: >=4.8.4 <6.1.0` and no v9 exists.
Adopting TS 7 buys compile speed and loses type-aware linting.

**Revisit when** typescript-eslint ships a release supporting TS 7.

---

## 7. ESLint 9.39.5, not 10.9.1

**Decision.** Pin ESLint 9 in both repos.

**Why.** `eslint-config-next@16` crashes at runtime on ESLint 10 with
`scopeManager.addGlobals is not a function` — its parser chain predates an ESLint 10
API change. ESLint 9 is inside every relevant peer range.

**Why both repos.** The backend worked fine on 10. Aligning both on 9 avoids a
version skew that someone would later "fix" in the wrong direction.

---

## 8. Relative imports with `.js` in the backend, bare specifiers in the frontend

**Decision.** Backend uses NodeNext resolution and writes `./foo.js`. Frontend uses
bundler resolution and writes `./foo`, with `@/` for app-router files.

**Why.** `tsc` does not rewrite import specifiers, so a path alias in a NodeNext ESM
build fails at runtime. Explicit `.js` is the boring option that works under `tsc`,
`tsx`, `vitest` and `node` with no extra tooling.

**Trap.** The two conventions are opposite. Copying an import style between repos
breaks the build; both are documented in their READMEs.

---

## 9. Vocabulary lives with the layer that derives it

**Decision.** `AGENT_CATEGORIES` in `modules/classification/taxonomy.ts`,
`PROTOCOL_TAGS` in `integrations/erc8004/registration-file.ts`. The database schema
restates neither.

**Why.** Both previously existed twice — a const in the schema file and a hand-written
union elsewhere. Adding a category to one left the other silently disagreeing. Types
are now derived from the const, so there is one source of truth.

**Bonus.** Both columns are plain `text` rather than a Postgres enum, so a fifth
category needs no migration.

---

## 10. Categories, reputation and search are their own modules

**Decision.** Four domain modules, not one agents service.

**Why.** `/categories` was originally served from the agents module, which meant one
domain reached through another to answer its own question. The four concerns also have
genuinely different freshness contracts — identity is immutable, profile can fail
independently, categories are derived by us, reputation moves continuously.

**Consequence.** `categories` owns `category.repository.ts` even though it reads the
same tables as `agents`. A shared repository is how two domains end up coupled
through SQL.

---

## 11. The taxonomy was widened from four categories to ten

**Decision.** `AGENT_CATEGORIES` now holds ten categories: the four BNB Agent Studio
launch categories plus `trading-execution`, `research-analytics`,
`automation-operations`, `security-verification`, `code-smart-contracts` and
`content-media`.

**Why.** Measured, not assumed. Indexing ~19k agents from the registry showed the four
DeFi categories matching **63 of them** — 0.3%. Everything else fell into
`uncategorized`, which is technically honest and practically useless: a marketplace
whose every filter returns nothing is not a marketplace.

The registry is not mostly DeFi agents. It is mostly trading, research, automation,
security, code and content agents. Measuring the description corpus before writing any
rules gave the shape of what is actually there:

| Cluster                  | Agents matching |
| ------------------------ | --------------- |
| trading / market analysis | ~6,850          |
| research / analytics      | ~220            |
| automation / ops          | ~190            |
| security / audit          | ~130            |
| code / smart contracts    | ~115            |
| content / writing         | ~115            |

After reclassification the index went from 63 classified agents to **5,074**, across 8
populated categories.

**What this is not.** It is not hardcoded categories to make the UI look populated.
Every new category is a `CategoryRule` in the same table, scored by the same
deterministic rules, with the same weights and thresholds, and every assignment still
ships the signals that produced it. An agent that matches nothing is still
`uncategorized`.

**Precedence.** The four launch categories are declared *first* in the list, and the
classifier breaks a score tie toward the earlier rule. So a grid-trading agent cannot
be absorbed into the broader `trading-execution` bucket. The generic rules also sit
later and are deliberately broader, which is why they lose ties rather than win them.

**Cost.** None at the schema level — both category columns are plain `text`, so this
needed no migration. Existing rows were updated by `pnpm reclassify`, which re-runs the
classifier from stored `raw_metadata` and capabilities without refetching a single
registration file. That is precisely why ingestion persists the raw document.

`CLASSIFIER_VERSION` moved to `rules-v2`, so a row classified under the four-category
taxonomy is distinguishable from one classified under ten.

**Still true:** `grid-trading` and `health-factor-monitoring` currently have zero
agents. The UI keeps them visible but disabled, labelled as awaiting agents, rather
than hiding them (which would misrepresent the declared scope) or offering them as
normal filters (which would look broken when clicked).

---

## 12. Fixtures are labelled synthetic and never claim a live read

**Decision.** `NEXT_PUBLIC_DATA_SOURCE=mock` serves fixtures through the *same* Zod
schemas as live responses, and `mockReputation` reports `origin: 'snapshot'` with a
"Mock data source" note.

**Why.** Mock mode exists so frontend work is never blocked on a synced database.
Parsing fixtures through the real contract means a fixture that drifts fails loudly.
Labelling them stops the UI from being built against a provenance claim that is false.

---

## 13. A misdiagnosis worth recording

`next build` failed for several iterations with
`Cannot read properties of null (reading 'useContext')` while prerendering
`/_global-error`. It was attributed to a known Next 16 bug, and the framework was
downgraded to Next 15 on that basis.

**That was wrong.** The real cause was `NODE_ENV=development` exported in the shell,
leaking into `next build`. Next 16.3.3 builds cleanly with `NODE_ENV=production`.
The downgrade was reverted.

Two lasting outcomes: `next build` must run with `NODE_ENV` unset or `production`
(noted in the frontend README), and the structural changes made while chasing the
phantom — the `(site)` route group, providers scoped to the routes that use them, the
wallet button excluded from SSR — were kept only because each stands on its own merit.
Their code comments were rewritten to state the real reason rather than the invented
one.

---

## 14. No authentication yet

**Decision.** No auth, and no auth scaffolding.

**Why.** There are no user-owned resources. Everything served is public on-chain data,
and an auth layer guarding nothing is code that will be wrong by the time it matters.

**Revisit** the moment hiring lands — that introduces user-owned sessions and spend
permissions, at which point authentication and authorisation become load-bearing.
Rate limiting, input validation, the SSRF guard and the error-leak policy are already
in place and do not depend on auth.
