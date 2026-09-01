# Deployment

Vercel for the frontend, Render for the API, Neon for Postgres. All three on free
tiers that do not expire, chosen so the marketplace stays reachable for months
without a card.

Going live changes environment values, not code. `NODE_ENV=production` is read in
five places and only one of them changes behaviour rather than tuning: hiring
refuses to point at mainnet unless it is set. The other four raise the database
pool from 4 to 10, tighten the rate limit from 1,000 to 120 requests a minute per
IP, switch the logger to JSON, and reject a wildcard `CORS_ORIGINS`.

## Why these three

| | Chosen | Rejected, and why |
| --- | --- | --- |
| API | **Render** free web service | **Railway** gives a one-off $5 credit that expires at 30 days or when spent, whichever comes first. It cannot cover a 2-3 month window. |
| Postgres | **Neon** free, 0.5 GB | **Render Postgres** free is deleted after 30 days, which would take the catalogue with it mid-judging. **Supabase** free is also 0.5 GB but pauses the whole project after 7 days idle and needs an explicit resume; Neon suspends only the compute and resumes on the next query. |
| Frontend | **Vercel** Hobby | Nothing to reject. Next.js on its own host. |

Render's free service spins down after 15 minutes without traffic and takes about
a minute to wake. That is the one sharp edge here, and the ingestion workflow
pings `/health` on its schedule to keep it warm. 750 free instance hours a month
covers one service running continuously (730), so staying awake costs nothing.

## Capacity, and why the catalogue is a snapshot

The database is 562 MB locally. A dump and restore drops it to 469 MB by shedding
ingestion bloat, and `scripts/snapshot.sh` takes it to **413 MB** — inside Neon's
512 MB with 99 MB spare.

That headroom only holds because **the deployed catalogue is a snapshot, not a
live index.** The registry grows at roughly 150-275 agents an hour. At about 1 KB
an agent that is ~130 MB a month, so two months of live ingestion into a 512 MB
database would run out of room regardless of any trimming. Pointing the ingestion
workflow at Neon is therefore a decision with a deadline attached, not a default.

So: ingestion keeps running against a full local database, and the deployed
catalogue is refreshed by re-running the snapshot when it is worth doing. This is
honest rather than hidden — `/health` reports `ingestion.status` separately from
overall health, so a snapshot shows `status: ok` with `ingestion: stale`, and the
`sync_state` timestamps say exactly when the index was last advanced.

Upgrade path, if the project outlives the demo: Neon's paid tier removes the
storage ceiling, and the workflow's `DATABASE_URL` secret can then point at it and
keep the deployed catalogue live. Nothing in the code changes.

### What the snapshot trims

`agents.raw_metadata` holds each agent's whole registration file so a mapper fix
can be replayed without re-fetching 244,000 URLs. That is worth keeping in
development and worth nothing in production: the API reads five keys out of it
(`image`, `services`, `supportedTrust`, `x402Support`, `active`) and carries the
rest without ever serving it. Trimming to those five saves 45 MB.

Verified behaviourally identical, not assumed: every value-level count matches
between the full and trimmed databases — 218,132 usable image URLs, 88,745
service arrays, 175,306 trust arrays, 13,805 x402 declarations. The only
difference is 18,016 keys whose value was an explicit JSON `null` being stripped,
which renders the same.

If that key list changes in `modules/agents/agent.repository.ts`, change it in
`scripts/snapshot.sh` too. A key dropped there empties a field on every agent page
with nothing to indicate why.

## Order of operations

Each step depends on the previous one's output, so they do not reorder.

### 1. Neon

Create a project. **Region must match Render's**, because the API makes several
queries per request and a cross-region pair adds a round trip to each one. Enable
Postgres only; object storage, functions, AI gateway and Neon Auth are all off.

Copy the pooled connection string, then restore into the empty database:

```bash
export NEON_URL='postgresql://…?sslmode=require'

cd KATTEGAT-BE
./scripts/snapshot.sh                       # ~40s, writes /tmp/kattegat-snapshot.dump
/opt/homebrew/opt/libpq/bin/pg_restore \
  --no-owner --no-privileges -d "$NEON_URL" /tmp/kattegat-snapshot.dump
```

**Do not run `db:migrate` first.** The dump is a full one and carries the schema,
the data and Drizzle's own `__drizzle_migrations` rows, so the restored database
already knows which migrations have run and `db:migrate` afterwards is a no-op.

That ordering was arrived at by rehearsing it locally, and the obvious alternative
fails. Migrating first and restoring `--data-only` aborts on foreign keys:
`pg_restore` loads tables in its own order, so `agent_categories` and
`agent_sessions` arrive before the `agents` rows they reference. A full restore has
no such problem because `pg_restore` adds constraints after the data.

Use the `libpq` `pg_restore`, not the one beside a local Postgres 14 server. The
rule for crossing versions is to use tools at least as new as the target, and Neon
is newer. `brew install libpq` provides them without a second server.

Then **run `ANALYZE`**, which `pg_restore` does not:

```bash
psql "$NEON_URL" -c "ANALYZE;"     # a few seconds
```

Not optional. A restored table has no statistics, so the planner guesses, and it
guesses badly enough to seq-scan a table it has a perfectly good index for.

Confirm before moving on:

```bash
psql "$NEON_URL" -c "SELECT count(*) FROM agents;"       # 317,476
psql "$NEON_URL" -c "SELECT count(*) FROM agent_jobs;"   # 56,681
psql "$NEON_URL" -c "SELECT pg_size_pretty(pg_database_size(current_database()));"
```

Measured on a Singapore Neon project, Postgres 18.6: restore 1m54s with `-j 3`,
**414 MB** on disk against the 512 MB ceiling, 19 indexes and 4 foreign keys
rebuilt, 5 Drizzle migrations already recorded.

### 2. Render

New Blueprint against this repository; `render.yaml` supplies everything except
the secrets, which it prompts for. Its `region` must equal the Neon region chosen
in step 1; change both together or neither.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the Neon pooled string |
| `CORS_ORIGINS` | the Vercel origin, once step 3 has given you one |
| `BSC_RPC_URL` | `https://bsc-dataseed.bnbchain.org` |
| `BSC_RPC_URL_FALLBACK` | `https://bsc-rpc.publicnode.com` |
| `AGENT_GAS_SPONSOR_PRIVATE_KEY` | optional; omit and users fund their own gas |

`CORS_ORIGINS` is the one that fails confusingly. Get it wrong and `curl` keeps
working while every browser request is blocked, so the API looks healthy and the
site looks broken.

### 3. Vercel

Import `KATTEGAT-FE`. One variable:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | the Render URL, no trailing slash |

Then go back and set `CORS_ORIGINS` on Render to the Vercel origin. Both hosts
redeploy on push to `main`.

### 4. Ingestion

The workflow in `.github/workflows/ingest.yml` needs `DATABASE_URL`,
`BSC_RPC_URL`, `BSC_RPC_URL_FALLBACK` and `IPFS_GATEWAY_URL` as repository
secrets. Read the capacity note above before pointing its `DATABASE_URL` at Neon:
on a free tier that is a choice with a deadline, and leaving it aimed at a full
database elsewhere is the safer default for a demo.

## Verifying a deployment

```bash
API=https://kattegat-api.onrender.com

curl -s $API/health | jq                                     # status ok, database up
curl -s "$API/api/v1/stats" | jq .data                       # 317,476 agents
curl -s "$API/api/v1/agents/56:269223/jobs?limit=1" | jq .meta.summary
```

The last one is the sharpest single check: it exercises Postgres, the escrow
mirror, and a live BSC read for the dispute window in one request.

Then open the site, a category page, and one agent profile. A profile that renders
its name but no endpoints means the snapshot trim dropped a key.
