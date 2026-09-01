# Deployment

Vercel for the frontend, Render for the API, Render Postgres for the database. All
free, chosen so the marketplace stays reachable without a card.

Going live changes environment values, not code. `NODE_ENV=production` is read in
five places and only one of them changes behaviour rather than tuning: hiring
refuses to point at mainnet unless it is set. The other four raise the database
pool from 4 to 10, tighten the rate limit from 1,000 to 120 requests a minute per
IP, switch the logger to JSON, and reject a wildcard `CORS_ORIGINS`.

## Why these three

| | Chosen | Rejected, and why |
| --- | --- | --- |
| API | **Render** free web service | **Railway** gives a one-off $5 credit that expires at 30 days or when spent, whichever comes first. It cannot cover a 2-3 month window. |
| Postgres | **Render Postgres** free, 1 GB | **Neon** free is 0.5 GB against a 432 MB catalogue, and its retained history counts toward the same allowance, so an in-place refresh peaks past the limit. **Supabase** free is also 0.5 GB and pauses the whole project after 7 days idle, needing an explicit resume. |
| Frontend | **Vercel** Hobby | Nothing to reject. Next.js on its own host. |

Render's free service spins down after 15 minutes without traffic and takes about
a minute to wake. That is the one sharp edge here, and the ingestion workflow
pings `/health` on its schedule to keep it warm. 750 free instance hours a month
covers one service running continuously (730), so staying awake costs nothing.

## Capacity, and why the catalogue is a snapshot

**A free Render Postgres expires 30 days after creation**, with a 14-day grace
period to upgrade before the data goes. That is the price of the 1 GB, and it is
the right trade for a demo with a fixed date: note the creation date, and if the
project outlives it, either upgrade or create a fresh instance and re-run the
restore workflow, which takes about five minutes.

The database is 576 MB locally at 325,546 agents. A dump and restore drops it to
487 MB by shedding ingestion bloat, and `scripts/snapshot.sh` takes it to **432
MB**, which the trigram and trait indexes below bring to **474 MB** on the
deployed instance. Against 1 GB that leaves real headroom. It was 413 MB at
317,476 agents, so budget roughly 2.4 MB per thousand agents when deciding whether
another refresh still fits.

That headroom only holds because **the deployed catalogue is a snapshot, not a
live index.** The registry grows at roughly 150-275 agents an hour. At about 1 KB
an agent that is ~130 MB a month, so continuous live ingestion would consume the
remaining space in about four months regardless of any trimming. Pointing the
ingestion workflow at the deployed database is therefore a decision with a
deadline attached, not a default.

So: ingestion keeps running against a full local database, and the deployed
catalogue is refreshed by re-running the snapshot when it is worth doing. This is
honest rather than hidden — `/health` reports `ingestion.status` separately from
overall health, so a snapshot shows `status: ok` with `ingestion: stale`, and the
`sync_state` timestamps say exactly when the index was last advanced.

### The other ceiling: a very small instance

Storage is the ceiling everyone plans for. The one that actually shapes this
deployment is the instance: **0.1 CPU and 256 MB RAM**, against an `agents` heap
of 290 MB.

The table does not fit in cache, and it is 290 MB because `raw_metadata` averages
933 bytes a row and stays inline rather than being TOASTed. So any query that has
to read the whole table reads it from disk, on a tenth of a core. Three
consequences, all measured, all handled:

- **Counts must come from indexes, not the heap.** Eight of the nine landing-page
  aggregates are index-only scans over structures of 2 to 18 MB. That only works
  if the visibility map is populated, which `VACUUM` builds and `ANALYZE` does
  not, so both restore and migrate workflows run `VACUUM ANALYZE` and report the
  resulting coverage.
- **Search needs trigram indexes.** `?q=` is `ilike '%term%'`, unindexable by
  btree, so it scanned the whole heap: about 10s through the API. GIN trigram
  indexes on `name` and `description` cost 44 MB and take a selective term to
  around 1ms.
- **Some predicates cannot be indexed, and that is fine.** `declared-active` is
  carried by 238,206 of 325,546 rows and `trading` matches 129,485; at those
  selectivities the planner correctly prefers a sequential scan. For the landing
  page this is solved by not putting the scan on the request path at all: the
  stats service serves the previous reading while refreshing behind it, and the
  process warms the cache at startup, so only a broad ad-hoc search still waits.

A larger instance would make all of this moot, which is the upgrade path if the
project outlives the demo. Nothing in the code changes.

### Why the keepalive pings /live and not /health

Render's free instance sleeps after 15 minutes, so a scheduled ping every 10
minutes keeps the API warm. What that ping asks for matters.

`/health` runs two queries, by design, because it reports database and ingestion
state. Pointing a permanent 10-minute ping at it means the database is never left
alone, which on this instance is wasted work and on a metered host is worse: it was
originally chosen for Neon, whose free plan bills awake compute against 100
CU-hours a month, and a query every 10 minutes around the clock spends roughly 90
of them proving the web process is up.

So the two questions get two endpoints. `/live` runs no queries and answers "is the
process up", which is all a keepalive needs. `/health` still costs queries and is
asked every 6 hours, often enough to catch a genuinely dead database.
`src/app/health.routes.test.ts` asserts `/live` touches no database, because a
query added there breaks nothing visible and would only surface much later.

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

### 1. Render Postgres

Create a Postgres instance. **Region must match the web service's**, because the
API makes several queries per request and a cross-region pair adds a round trip to
each one. Free tier is fixed at 1 GB, 0.1 CPU, 256 MB RAM; pick Postgres 18 so it
matches the `libpq` tooling used for dumps. Name the database and user explicitly
(`kattegat` / `kattegat`) rather than accepting the generated ids, so connection
strings are readable.

**Leave Storage Autoscaling off.** It grows the disk by 50% "rounded up to the
nearest 5 GB" at 90% full, so one trigger takes a free 1 GB instance to a billable
5 GB. At 474 MB it will not fire, and off is the setting that cannot surprise you.

Two connection strings come out of this, and both get used:

| | Used by | Note |
| --- | --- | --- |
| **Internal** | `DATABASE_URL` on the web service | Private network, no domain suffix, lower latency. Only resolves inside Render. |
| **External** | `DEPLOYED_DATABASE_URL` Actions secret, and `pnpm dev:deployed` | Reachable from outside. Requires `sslmode=require`. |

Then load the catalogue. **This runs from CI, not from a laptop:**

```bash
./scripts/snapshot.sh                    # ~40s, writes /tmp/kattegat-snapshot-new.dump
gh release create snapshot-latest /tmp/kattegat-snapshot-new.dump --notes 'catalogue snapshot'
gh secret set DEPLOYED_DATABASE_URL      # paste the external string
gh workflow run restore-catalogue.yml -f release_tag=snapshot-latest -f confirm=RESTORE
```

`.github/workflows/restore-catalogue.yml` resets both schemas, restores with
`-j 1`, runs `VACUUM ANALYZE`, and fails if fewer than 300,000 agents land. About
5 minutes. Delete the release once verified; it is a full copy of the catalogue.

**Why CI and not `pg_restore` from here.** Plenty of networks drop outbound 5432.
The TCP handshake completes, the Postgres startup packet is discarded, and every
client reports `server closed the connection unexpectedly` — identical to a crashed
backend, a wrong password and an exhausted quota. That ambiguity cost this project a
day, across two confident and wrong diagnoses of a database that was healthy
throughout. If you must debug it locally, test a Postgres you know is up first;
`sslmode=disable` failing the same way proves it is not TLS.

Schema changes work the same way, through
`.github/workflows/migrate-deployed.yml`, which runs Drizzle's migrator and is a
no-op if everything is already applied.

**Do not run `db:migrate` before the restore.** The dump is a full one and carries
the schema, the data and Drizzle's `__drizzle_migrations` rows, so the restored
database already knows what has run and a later `db:migrate` is a no-op.

That ordering was arrived at by rehearsing it, and the obvious alternative fails.
Migrating first and restoring `--data-only` aborts on foreign keys: `pg_restore`
loads tables in its own order, so `agent_categories` and `agent_sessions` arrive
before the `agents` rows they reference. A full restore has no such problem because
`pg_restore` adds constraints after the data.

Use client tools at least as new as the target. `brew install libpq` provides
Postgres 18 tools without a second server; the workflow installs
`postgresql-client-18` from PGDG for the same reason, because the runner image
ships 16 and `pg_restore` refuses an archive newer than itself.

Two traps worth knowing, both of which the workflow already handles.

**`VACUUM ANALYZE`, not `ANALYZE`.** `ANALYZE` gives the planner statistics, without
which it sequential-scans tables that have perfectly good indexes. `VACUUM` builds
the visibility map, without which an index-only scan is impossible because the
executor cannot tell that a heap page is all-visible. On this schema that is the
difference between answering a count from a 2 MB index and reading the 290 MB heap:
the landing page's aggregate measured 9.4s with statistics but no visibility map.

**`CREATE SCHEMA public` is not optional if you drop it.** `pg_dump` emits
`CREATE SCHEMA drizzle` but never `CREATE SCHEMA public`, because Postgres treats it
as pre-existing. Drop it without recreating it and the restore fails once per
object with `schema "public" does not exist`, having loaded nothing:

```sql
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;                  -- required; the dump does not create it
```

```bash
pg_restore -f - /tmp/kattegat-snapshot-new.dump | grep -i '^CREATE SCHEMA'
```

Measured on Render Postgres 18, Singapore, free tier: restore 4m40s with `-j 1`,
**474 MB** on disk against the 1 GB ceiling including the trigram and trait
indexes, 21 indexes and 4 foreign keys rebuilt, 7 Drizzle migrations recorded,
visibility map 28,960 of 28,960 pages. Row counts: 325,546 agents, 327,697
categories, 325,546 reputation rows, 56,681 jobs.

#### Refreshing the catalogue later

Re-run the same two commands: upload a fresh snapshot to the release, dispatch
`restore-catalogue.yml`. It resets the schemas first, so it is the same operation
whether the database is empty or not, and the 1 GB ceiling leaves room for the
rewrite.

That is worth contrasting with what this used to require. On a 0.5 GB tier where
retained history counts toward the allowance, an in-place refresh peaks at roughly
double the final size, because dropping 414 MB does not free it before the restore
adds 432 MB on top. The way out was a new project each time and repointing
`DATABASE_URL`. On 1 GB with no history accounting, an in-place refresh is simply
fine.

### 2. Render

New Blueprint against this repository; `render.yaml` supplies everything except
the secrets, which it prompts for. Its `region` must equal the database region
chosen in step 1; change both together or neither.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the database's **internal** string from step 1 |
| `HOST` | leave unset; it resolves to `0.0.0.0` when `NODE_ENV=production` |
| `CORS_ORIGINS` | the Vercel origin, once step 3 has given you one |
| `BSC_RPC_URL` | `https://bsc-dataseed.bnbchain.org` |
| `BSC_RPC_URL_FALLBACK` | `https://bsc-rpc.publicnode.com` |
| `AGENT_GAS_SPONSOR_PRIVATE_KEY` | optional; omit and users fund their own gas |

`CORS_ORIGINS` is the one that fails confusingly. Get it wrong and `curl` keeps
working while every browser request is blocked, so the API looks healthy and the
site looks broken.

#### If you configure the service by hand instead

The Blueprint flow reads `render.yaml`; the "New Web Service" flow does not, so
everything in it has to be typed. Build command:

```
corepack enable && pnpm install --frozen-lockfile && pnpm build
```

`corepack enable` so the pinned `packageManager` is honoured and
`--frozen-lockfile` is not comparing against a different pnpm's lockfile format,
and `&&` rather than `;` so a failed install does not go on to report a
misleading TypeScript error.

Start command is `pnpm start`, health check path `/health`, and the variables are
those in `render.yaml` plus `NODE_ENV`, `LOG_LEVEL` and `NODE_VERSION`.

Two things not to do. Do not set `PORT`: the platform injects it and the app reads
it, so overriding it breaks routing. And do not use "Add from .env", which will
inject `NODE_ENV=development` and a `DATABASE_URL` pointing at `127.0.0.1` — the
container then tries to reach a Postgres inside itself and fails in a way that
reads as a database outage rather than a configuration mistake.

Also set the repository variable `API_URL` to the service's public URL, or the
keepalive workflow exits successfully having done nothing, and the instance sleeps
after 15 minutes as if the workflow were not there.

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
secrets. Read the capacity note above before pointing its `DATABASE_URL` at the
deployed database: on a free tier that is a choice with a deadline, and leaving it
aimed at a full database elsewhere is the safer default for a demo.

## Verifying a deployment

```bash
API=https://kattegat-be.onrender.com

curl -s $API/health | jq                                     # status ok, database up
curl -s $API/live | jq                                       # 200 without touching Postgres
curl -s "$API/api/v1/stats" | jq .data                       # 325,546 agents
curl -s "$API/api/v1/agents?q=arbitrage&per_page=3" | jq .meta   # ~1s, not ~10s
curl -s "$API/api/v1/agents/56:269223/jobs?limit=1" | jq .meta.summary
```

The jobs call is the sharpest single check: it exercises Postgres, the escrow
mirror, and a live BSC read for the dispute window in one request.

The search call is the check that the trigram indexes are present and analysed. If
it takes about ten seconds, the migration has not been applied or `VACUUM ANALYZE`
has not run; dispatch `migrate-deployed.yml`.

Use a real category slug when spot-checking. They are values like
`trading-execution` and `yield-optimization`, not `trading`, and a wrong one is a
422 from the API and a 404 from the site, which looks like a fault and is not.

Then open the site, a category page, and one agent profile. Note that the frontend
fetches client-side through TanStack Query, so `curl` on a page returns HTML with no
figures in it; that is expected, and it means CORS is the thing to check when the
API works but the site shows nothing. A profile that renders its name but no
endpoints means the snapshot trim dropped a key.
