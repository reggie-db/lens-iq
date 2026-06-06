#!/usr/bin/env bash
# Idempotent Lakebase schema bootstrap for the lens-iq app.
#
# The app's service principal only has `CAN_CONNECT_AND_CREATE` on the bound
# Lakebase database (see resources/app.yml -> postgres). That grant lets it
# create *new* schemas / extensions / tables and own them, but it does NOT
# grant access to a schema that already exists under a different owner. The
# most common reason a schema exists under another owner is that someone (or
# CI) ran the dev server locally before the first deploy, so their user
# identity is now the schema owner. After that point the SP is locked out
# and every `_ensureXTable` call in server/server.ts surfaces a
# `permission denied for schema <name>` error.
#
# This script bridges that gap by running as the deploying user (project
# owners automatically have `databricks_superuser`, the only role that can
# hand out cross-owner grants) and granting USAGE + CREATE on the schema
# to PUBLIC. PUBLIC is the Postgres pseudo-role for "every role that can
# connect, including future roles", so this also covers any future SP that
# the platform rotates in.
#
# Re-running is safe:
#   * `CREATE SCHEMA IF NOT EXISTS` is a no-op when the schema exists.
#   * `GRANT` and `ALTER DEFAULT PRIVILEGES` are idempotent (re-applying
#     the same row in pg_default_acl is a no-op).
#
# Usage:
#   scripts/grant-lakebase-schema.sh               # uses defaults below
#   LAKEBASE_SCHEMA=foo scripts/grant-lakebase-schema.sh
#   DATABRICKS_PROFILE=lensiq-prod scripts/grant-lakebase-schema.sh
set -euo pipefail

# Lakebase target. Overridable via env so CI can point at a non-default
# branch/database without editing this script. Defaults mirror the
# `lakebase_database` bundle variable in databricks.yml.
LAKEBASE_PROJECT="${LAKEBASE_PROJECT:-lens-iq}"
LAKEBASE_BRANCH="${LAKEBASE_BRANCH:-production}"
LAKEBASE_ENDPOINT_ID="${LAKEBASE_ENDPOINT_ID:-primary}"
# Postgres database name (the in-DB name shown in `\l` output, not the
# Lakebase resource id used by the CLI commands). The standard
# auto-created database on a fresh Lakebase Autoscaling production
# branch is named `databricks_postgres` (the bundle binds the matching
# `databricks-postgres` resource id, see databricks.yml::lakebase_database).
LAKEBASE_DB_NAME="${LAKEBASE_DB_NAME:-databricks_postgres}"
# Schemas the app expects. `app_data` (see APP_SCHEMA in
# server/server.ts) holds every table the LensIQ app writes through
# AppKit. `appkit` is auto-created by the @databricks/appkit cache
# plugin's persistent-storage backend on first boot; the same
# cross-owner problem applies, so both schemas get the PUBLIC bootstrap
# here. Override with a colon-separated list to add more.
LAKEBASE_SCHEMAS="${LAKEBASE_SCHEMAS:-${LAKEBASE_SCHEMA:-app_data:appkit}}"

DATABRICKS_PROFILE_FLAG=()
if [[ -n "${DATABRICKS_PROFILE:-}" ]]; then
  DATABRICKS_PROFILE_FLAG=(-p "$DATABRICKS_PROFILE")
fi

_log() { printf "\033[1;34m[grants]\033[0m %s\n" "$*"; }
_fail() { printf "\033[1;31m[grants]\033[0m %s\n" "$*" >&2; exit 1; }

command -v psql >/dev/null 2>&1 \
  || _fail "psql not on PATH. Install with 'brew install libpq' (macOS) and 'brew link --force libpq'."
command -v jq >/dev/null 2>&1 \
  || _fail "jq not on PATH. Install with 'brew install jq'."

endpoint_name="projects/${LAKEBASE_PROJECT}/branches/${LAKEBASE_BRANCH}/endpoints/${LAKEBASE_ENDPOINT_ID}"

# `${arr[@]+"${arr[@]}"}` is the standard workaround for the bash quirk
# where `"${arr[@]}"` trips `set -u` when the array is empty.
PGHOST="$(databricks postgres get-endpoint "$endpoint_name" \
  ${DATABRICKS_PROFILE_FLAG[@]+"${DATABRICKS_PROFILE_FLAG[@]}"} --output json \
  | jq -r '.status.hosts.host // empty')"
[[ -n "$PGHOST" ]] || _fail "could not resolve PGHOST from get-endpoint $endpoint_name"

PGPASSWORD="$(databricks postgres generate-database-credential "$endpoint_name" \
  ${DATABRICKS_PROFILE_FLAG[@]+"${DATABRICKS_PROFILE_FLAG[@]}"} --output json \
  | jq -r '.token // empty')"
[[ -n "$PGPASSWORD" ]] || _fail "could not mint OAuth credential for $endpoint_name"

PGUSER="$(databricks current-user me \
  ${DATABRICKS_PROFILE_FLAG[@]+"${DATABRICKS_PROFILE_FLAG[@]}"} --output json \
  | jq -r '.userName // empty')"
[[ -n "$PGUSER" ]] || _fail "could not resolve current-user from databricks CLI"

export PGSSLMODE=require PGPASSWORD

# `:"schema"` is psql's identifier-quoting variable substitution; it produces
# correctly quoted "app_data" in every position. Loop over each schema so
# the SP and any future role can read/write both the LensIQ app's tables
# and the AppKit cache plugin's bookkeeping tables.
IFS=':' read -r -a _schemas <<< "$LAKEBASE_SCHEMAS"
for _schema in "${_schemas[@]}"; do
  [[ -n "$_schema" ]] || continue
  _log "applying to ${LAKEBASE_DB_NAME}.${_schema} (as ${PGUSER}@${PGHOST})"
  psql -h "$PGHOST" -p 5432 -U "$PGUSER" -d "$LAKEBASE_DB_NAME" \
    -v ON_ERROR_STOP=1 -v schema="${_schema}" --quiet <<'SQL'
CREATE SCHEMA IF NOT EXISTS :"schema";
GRANT USAGE, CREATE ON SCHEMA :"schema" TO PUBLIC;
GRANT ALL ON ALL TABLES    IN SCHEMA :"schema" TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA :"schema" TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA :"schema" GRANT ALL ON TABLES    TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA :"schema" GRANT ALL ON SEQUENCES TO PUBLIC;
SQL
done

_log "done."
