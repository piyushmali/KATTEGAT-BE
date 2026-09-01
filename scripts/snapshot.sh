#!/usr/bin/env bash
#
# Produces a deployable snapshot of the catalogue, small enough for a free Postgres tier.
#
# WHY A SNAPSHOT AND NOT A RE-SYNC
#
# Rebuilding the catalogue on the target would take hours (a full id walk plus a 31-minute
# reputation sweep) and, on a metered host, would spend the monthly compute allowance doing
# work already done here. Restoring a dump takes seconds.
#
# WHY IT TRIMS raw_metadata
#
# The column holds each agent's whole registration file, 92MB across the catalogue, so that a
# mapper fix can be replayed without re-fetching 244,000 URLs. That is worth keeping in
# development and worth nothing in production: the API reads exactly five keys out of it, and
# the rest is carried but never served.
#
# Trimming to those five takes the restored database from 469MB to comfortably inside a 512MB
# free tier. The trim happens on a throwaway copy, so this database keeps the full documents and
# a replay is still possible here.
#
# The five keys are read in modules/agents/agent.repository.ts. If that list changes, change it
# here too: a key dropped here silently empties a field on every agent page, which is why they
# are named explicitly rather than filtered by a denylist.
#
# Usage:
#   ./scripts/snapshot.sh                                   # from the local dev database
#   ./scripts/snapshot.sh "$SOURCE_URL" out.dump            # explicit source and output
set -euo pipefail

SOURCE="${1:-postgres://$(whoami)@127.0.0.1:5432/kattegat}"
OUTPUT="${2:-/tmp/kattegat-snapshot.dump}"
SCRATCH="kattegat_snapshot_build"

# Two sets of client tools, used for different hops, because the version rule cuts both ways.
#
# The scratch copy below is local-to-local, so it needs tools matching the LOCAL server. The final
# dump targets Neon, which runs a newer Postgres, and the rule for moving between versions is to
# dump with tools at least as new as the TARGET.
#
# Mixing them up is not theoretical, and it happened twice. Dumping with newer tools and restoring
# into the older local server fails on `SET transaction_timeout = 0`, a parameter that did not
# exist before 17.
#
# Neither set is taken from PATH, which is the fix for the second occurrence: the first version of
# this script asked PATH for the "local" tools, and a caller who happened to put libpq ahead of
# Homebrew's postgres got the new ones for both hops and the same failure. So the local tools are
# resolved from the server's own major version, and the target tools from libpq.
LOCAL_MAJOR="$(psql "$SOURCE" -tAc "select current_setting('server_version_num')::int / 10000" 2>/dev/null || echo '')"
LOCAL_BIN=""
if [ -n "$LOCAL_MAJOR" ] && [ -x "/opt/homebrew/opt/postgresql@${LOCAL_MAJOR}/bin/pg_dump" ]; then
  LOCAL_BIN="/opt/homebrew/opt/postgresql@${LOCAL_MAJOR}/bin"
fi
LOCAL_PG_DUMP="${LOCAL_BIN:+$LOCAL_BIN/}pg_dump"
LOCAL_PG_RESTORE="${LOCAL_BIN:+$LOCAL_BIN/}pg_restore"

LIBPQ_BIN="/opt/homebrew/opt/libpq/bin"
TARGET_PG_DUMP="pg_dump"
if [ -x "$LIBPQ_BIN/pg_dump" ]; then
  TARGET_PG_DUMP="$LIBPQ_BIN/pg_dump"
fi

echo "local server  ${LOCAL_MAJOR:-unknown}"
echo "local tools   $("$LOCAL_PG_DUMP" --version | awk '{print $3}')"
echo "target tools  $("$TARGET_PG_DUMP" --version | awk '{print $3}')"

# Refuse rather than produce a dump that silently lost rows to an ignored error.
if [ -n "$LOCAL_MAJOR" ] && [ "$("$LOCAL_PG_DUMP" --version | awk '{print $3}' | cut -d. -f1)" != "$LOCAL_MAJOR" ]; then
  echo "error: local tools are $("$LOCAL_PG_DUMP" --version | awk '{print $3}') but the source server is $LOCAL_MAJOR." >&2
  echo "       Install postgresql@${LOCAL_MAJOR} client tools, or run against a server matching your tools." >&2
  exit 1
fi

echo "source  $SOURCE"
echo "output  $OUTPUT"

# A throwaway copy, so the trim below never touches the source.
dropdb --if-exists "$SCRATCH"
createdb "$SCRATCH"
"$LOCAL_PG_DUMP" --no-owner --no-privileges -Fc "$SOURCE" | "$LOCAL_PG_RESTORE" --no-owner --no-privileges -d "$SCRATCH"

BEFORE=$(psql -tAc "SELECT pg_size_pretty(pg_database_size('$SCRATCH'))" "$SCRATCH")

# Exactly the keys the serve path reads. `- '{}'::text[]` is not used on purpose: an allowlist
# fails safe when a registration file carries something unexpected, a denylist does not.
psql -q "$SCRATCH" <<'SQL'
UPDATE agents
SET raw_metadata = jsonb_strip_nulls(
  jsonb_build_object(
    'image',          raw_metadata -> 'image',
    'services',       raw_metadata -> 'services',
    'supportedTrust', raw_metadata -> 'supportedTrust',
    'x402Support',    raw_metadata -> 'x402Support',
    'active',         raw_metadata -> 'active'
  )
)
WHERE raw_metadata IS NOT NULL;
SQL

# Reclaims the space the update just orphaned. Without this the file keeps the old rows and the
# dump is no smaller, because a plain VACUUM makes space reusable rather than giving it back.
psql -q "$SCRATCH" -c "VACUUM FULL ANALYZE;"

AFTER=$(psql -tAc "SELECT pg_size_pretty(pg_database_size('$SCRATCH'))" "$SCRATCH")

# The one hop that targets a newer server, so it uses the newer tools.
"$TARGET_PG_DUMP" --no-owner --no-privileges -Fc "$SCRATCH" -f "$OUTPUT"
dropdb "$SCRATCH"

echo
echo "restored size  $BEFORE -> $AFTER"
echo "dump           $(du -h "$OUTPUT" | cut -f1)"
echo
echo "Restore with:"
echo "  pg_restore --no-owner --no-privileges -d \"\$NEON_URL\" $OUTPUT"
