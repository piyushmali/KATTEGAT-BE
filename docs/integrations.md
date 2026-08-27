# Integrations

Everything in `src/integrations/` is an adapter to something outside this service.
The rule is that marketplace code depends on our interfaces, never on a provider's
response shape, so a provider can be replaced without touching domain logic.

Every limit below was measured against BSC mainnet, not read off a marketing page.

## ERC-8004 on BNB Smart Chain — primary source

The registries sit at CREATE2-deterministic addresses, byte-identical on every
supported mainnet:

| Registry             | Address                                      |
| -------------------- | -------------------------------------------- |
| `IdentityRegistry`   | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| `ReputationRegistry` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

Verified on chain 56: `name()` returns `AgentIdentity`, `symbol()` returns `AGENT`.
ABIs were transcribed from the canonical Hardhat artifacts at
[erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) into a
narrow read-only subset in `erc8004/abi.ts`. No write methods are included — this
service holds no key and signs nothing.

### Discovery is log replay, not enumeration

`IdentityRegistry.totalSupply()` **reverts**. The contract is ERC-721 but not
`ERC721Enumerable`, so there is no way to walk agents by index. The only discovery
path is replaying:

```
Registered(uint256 indexed agentId, string agentURI, address indexed owner)
```

`agentId` and `owner` are indexed; `agentURI` is not.

### Reputation reads

`getSummary(agentId, clients, tag1, tag2)` returns
`(count, summaryValue, summaryValueDecimals)` — the average of non-revoked feedback,
as fixed point.

Two behaviours to know:

- It **reverts with `clientAddresses required`** on an empty list, so
  `getClients(agentId)` must be called first. An agent with no clients is answered
  without the second call.
- The result is fixed point. The real score is
  `summaryValue / 10 ** summaryValueDecimals`. Ignoring the exponent renders 4.25 as
  425.

### Registration files

`agentURI` resolves to the off-chain document described by the spec
(`#registration-v1`): `name`, `description`, `services[]`, `x402Support`, `active`,
`registrations[]`, `supportedTrust[]`. From it we derive the protocol tag, trait tags
and capabilities.

**This is a trust boundary.** The URI is set on chain by whoever registered the
agent, so `registration-file.ts` enforces:

- scheme allowlist — `ipfs://`, `https://`, `data:`; plain `http://` is refused
  rather than silently upgraded, so provenance stays unambiguous
- DNS resolution checked against loopback, link-local (including the cloud metadata
  address `169.254.169.254`), RFC1918 and unique-local ranges
- `redirect: 'error'` — no following redirects off the vetted host
- 512 KB cap enforced while streaming, not just from `Content-Length`
- 8 s timeout

A documented limitation: the check is on the resolved address, so it does not defend
against DNS rebinding between our lookup and the connect. Closing that needs a
dispatcher pinned to the verified IP. Acceptable here because the response is parsed
as JSON and never executed or echoed. Flagged in a `ponytail:` comment in the source.

**Real-world calibration.** Registration files in the wild serialise absent values as
JSON `null` (`"image": null`), not by omitting the key. Zod's `.optional()` accepts
`undefined` but rejects `null`, so the first live run discarded **202 of 235 agents**
over a field nothing reads. The schema uses `.nullish()` throughout; resolution went
from 33/235 to 242/243.

**Capabilities are taxonomy paths, not words.** Real agents publish OASF skill
identifiers such as `energy/smart_grids`, `finance_and_business/banking` and
`advanced_reasoning_planning/strategic_planning`. The classifier originally matched a
capability term with `capability.includes(term)`, which read `energy/smart_grids` as
the grid-trading term `grid` and labelled six general-purpose agents as grid-trading
bots. Capability matching is now whole-token against each `/`-delimited segment, and
deliberately unstemmed — stemming would make `grid` match `grids` and reintroduce the
same false positive. The offending capability list is pinned as a regression test in
`classifier.test.ts`.

## RPC endpoints — the real constraint

Most public BSC endpoints cannot serve `eth_getLogs`, which is the one method
ingestion depends on. Measured:

| Endpoint                        | `eth_getLogs`                          |
| ------------------------------- | -------------------------------------- |
| `bsc-rpc.publicnode.com`        | **works**, 2000-block windows fine     |
| `bsc.rpc.blxrbdn.com`           | **works**, 2000-block windows fine     |
| Alchemy (`bnb-mainnet`, free)   | capped at **10 blocks** — but archive state reads work |
| `bsc-dataseed*.bnbchain.org`    | rejected — `limit exceeded` (-32005), even for 119 blocks |
| `bsc-dataseed1.defibit.io`      | rejected — `limit exceeded`            |
| `bsc.meowrpc.com`               | method not supported                   |
| `1rpc.io/bnb`                   | capped at 50 blocks                    |
| `bsc.blockrazor.xyz`            | capped at 25 blocks                    |
| `bsc.drpc.org`                  | rate limited on the free tier          |

Defaults are set to the two that work. `viem`'s `fallback` transport rotates on
transport errors.

### Log retention limits backfill

No free endpoint offers archive access. Historical `eth_getCode` and `eth_getLogs`
both answer `Archive requests require a personal token`. Bisection put usable log
retention at roughly **8,000 blocks** — about two hours at BSC block times.

Consequences, and how the code handles them:

- **Deploy-block discovery by bisecting `eth_getCode` is impossible.** It converges
  on the chain head, because historical state reads fail rather than returning `0x`.
  Replaced with `oldestAvailableLogBlock()`, which bisects on `eth_getLogs` success —
  logs are retained separately from state, so that boundary is real. ~14 requests.
- **Requests for more history than the endpoint holds are clamped, not attempted.**
  `resolveStartBlock()` returns `{ fromBlock, clamped }` and the sync logs a warning,
  so an operator sees "I could not reach that far back" instead of an empty import.
- **Full historical backfill needs an archive-capable provider.** Set `BSC_RPC_URL`
  to one and raise `ERC8004_MAX_LOOKBACK_BLOCKS`. Free tiers with a token exist from
  Allnodes/publicnode, QuickNode, Alchemy and dRPC.

Forward incremental sync works on the free endpoints indefinitely; only reaching
backwards is limited.

### The ID walk: why backfill does not use logs at all

Log retention caps history at roughly two hours on any free tier, and Alchemy's free
plan caps `eth_getLogs` at 10 blocks — so no free endpoint can replay the registry's
log history. That looked like a hard wall until the constraint turned out to be
avoidable rather than negotiable.

ERC-8004 mints agent ids from a **sequential counter**, and `ownerOf(id)` reverts only
for an id that was never minted. Verified on chain 56: `ownerOf(1)` resolves,
`ownerOf(310063)` resolves, `ownerOf(400000)` reverts. So the whole registry is
enumerable with plain `eth_call` — no logs, no archive access, no retention limit.

`discoverByIdRange` therefore reads `ownerOf`, `tokenURI` and `getAgentWallet` for a
range of ids via Multicall3 (chunked at 120 ids per call, because `tokenURI` returns a
full URI per agent and a larger bundle exceeds response limits), then resolves each
registration file through the same code path as log replay.

`highestAgentId()` finds the ceiling by doubling then bisecting `ownerOf` — about 20
calls. At the time of writing it reports **310,063 agents**.

Two honest limitations:

- **`registeredAt` is unknown on this path.** The timestamp lives in the `Registered`
  log, which the ID walk deliberately does not read. It is stored as null rather than
  guessed. Because ids are monotonic with registration order, the repository falls
  back to ordering by agent id when the date is missing.
- **Older agents often have dead metadata.** In the 1500–1900 id range, 392 of 400
  registration files failed to resolve — early URIs have rotated or gone offline.
  Those agents are still indexed with verified on-chain identity and
  `metadata_resolved_at: null`.

So the two strategies are complementary, not redundant:

| Strategy   | Command                        | Reaches                  | Bounded by            |
| ---------- | ------------------------------ | ------------------------ | --------------------- |
| Log replay | `pnpm sync:agents`             | new registrations        | RPC log retention     |
| ID walk    | `pnpm sync:agents --backfill`  | the entire registry      | metadata fetch time   |

Backfill is resumable: progress is stored under its own `:backfill` cursor (the
`last_block` column holds the last agent id), so `--loop` can be interrupted and
loses at most one batch.

## ERC-8004 Explorer (QuickNode) — optional enrichment

`erc-8004.quicknode.com/v1` offers richer data including a computed reputation with
explainable sub-scores.

**It is paywalled per request via x402** — about $0.001 USDC on Base per call, with
no API key to provision. Rate limits are 300 req/min per IP overall and 60 req/min on
`/v1/agents`.

This is why it is **not** the primary source. A demo that needs a funded x402 signer
for every page load is not a reliable demo, and reading the registries directly is
free and authoritative anyway. It is disabled by default
(`ERC8004_EXPLORER_ENABLED=false`) and used only as additive enrichment on
`GET /agents/:id/reputation`.

A `402` response maps to the distinct error code `UPSTREAM_PAYMENT_REQUIRED`, because
the fix is operational — fund a signer — not a code change.

Note the shape mismatch that shaped the interface: the Explorer paginates by page
number while `AgentSource.discover` walks block ranges. Rather than force both into
one abstraction and get something that fits neither, the Explorer implements a
narrower `AgentEnrichmentSource` (`fetchAgent`, `fetchReputation`).

## AI providers — optional

`integrations/ai/provider.ts` defines one `AiProvider` interface and a single
implementation that speaks the OpenAI-compatible `/chat/completions` shape over plain
`fetch`. That covers OpenAI, Groq, Together, OpenRouter, Ollama and vLLM, so no
vendor SDK is a dependency and switching providers is an env change.

Disabled by default (`AI_PROVIDER=none`). Its one consumer is the search module,
which asks a model to pick a category **only** when the deterministic rules find
none, validates the answer against the known category list, and falls back to the
deterministic result on any failure. Classification itself never calls a model — see
[`architecture.md`](architecture.md) for why.

A null provider is a supported state, not a degraded one. Nothing in the marketplace
depends on model availability to render.

## Fallback summary

| Dependency               | Primary                      | Fallback                                  |
| ------------------------ | ---------------------------- | ----------------------------------------- |
| BSC RPC                  | `BSC_RPC_URL`                | `BSC_RPC_URL_FALLBACK` via viem `fallback` |
| Agent reputation         | live registry read           | stored snapshot, labelled `origin: snapshot` |
| Registration file        | `agentURI`                   | agent persisted with `metadata_resolved_at: null` |
| Enriched reputation      | Explorer (if enabled)        | omitted; `explorer: null`                 |
| Search category          | deterministic rules          | optional model; rules stand on failure    |
| Frontend data source     | this API                     | `NEXT_PUBLIC_DATA_SOURCE=mock` fixtures   |

No single external service can take down a page.

## Partner extension points

Not implemented. Documented here rather than created as empty folders.

**TermiX.** Worth noting from the live data: TermiX is currently the **dominant
registrar** on BSC ERC-8004 — 220 of 243 agents in the scanned window resolve to
`termix-platform-prod.s3.ap-southeast-1.amazonaws.com`, with 9 from
`metadata.evoevo.ai`. The agent-versus-manual execution comparison in the partner
track would attach as a new adapter plus a comparison module; the ingestion path is
unaffected.

**Altana.** Agent-controlled wallets, session limits, expiry, revocation. Attaches
beside a future hiring module. `agents.wallet_address` is already captured from
`getAgentWallet` for every agent, so the identity half of the seam exists.

**PancakeSwap.** Pool, liquidity and yield data to enrich yield-optimization agents.
Shape it like `explorer-client.ts` — an enrichment source layered on top of the base
record, never a dependency for rendering an agent.

## Verifying it works

```bash
pnpm verify:chain
```

Reads the registry name, probes the servable log window, scans `Registered` logs,
resolves registration files, classifies everything it found and reads one agent's
reputation. Exits non-zero on failure, so it is usable as a CI smoke check. Needs an
RPC endpoint only — no database.
