#!/usr/bin/env bash
# Idempotent Unity Catalog / Genie / serving grants for the LensIQ app.
#
# Two distinct identities need access and neither is fully covered by the
# bundle:
#
#   1. The app service principal. resources/app.yml binds the warehouse,
#      Genie space, serving endpoints, volumes, and Lakebase, but a
#      `uc_securable` volume binding only grants the leaf volume. The SP still
#      needs table-level rights on the demo schema, or the UC mirror writes
#      fail with `PERMISSION_DENIED: User does not have SELECT on Table ...`.
#
#   2. Signed-in workspace users. Ask LensIQ runs on-behalf-of-user, so the
#      SP's bindings do not apply to the user's OAuth token. Without the
#      grants below, non-admin users can open the app but the Genie chat
#      fails on Genie, warehouse, UC table, or serving permission errors.
#
# Re-running is safe: permission patches and GRANT statements are idempotent.
#
# Usage:
#   scripts/grant-app-access.sh
#   GENIE_SPACE_ID=01f1... DATABRICKS_CONFIG_PROFILE=fe-vm-foo scripts/grant-app-access.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PROFILE="${DATABRICKS_CONFIG_PROFILE:-${DATABRICKS_PROFILE:-}}"
CATALOG="${DATABRICKS_CATALOG:-reggie_pierce_aws_catalog}"
SCHEMA="${DATABRICKS_SCHEMA:-lens_iq}"
GENIE_SPACE_ID="${GENIE_SPACE_ID:-${DATABRICKS_GENIE_SPACE_ID:-}}"
GENIE_STATE_FILE=".databricks/state/genie_space_id"

LENSIQ_ENDPOINTS="${LENSIQ_ENDPOINTS:-lensiq-detector lensiq-license-plate lensiq-slip-fall lensiq-fog-detector lensiq-face-recognition}"

APP_NAME="${APP_NAME:-lens-iq}"

_log() { printf "\033[1;34m[app-grants]\033[0m %s\n" "$*"; }
_warn() { printf "\033[1;33m[app-grants]\033[0m %s\n" "$*" >&2; }
_fail() { printf "\033[1;31m[app-grants]\033[0m %s\n" "$*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || _fail "jq not on PATH"

[[ -n "$PROFILE" ]] || _fail "Set DATABRICKS_CONFIG_PROFILE (or DATABRICKS_PROFILE) in .env or the environment"

if [[ -z "$GENIE_SPACE_ID" && -f "$GENIE_STATE_FILE" ]]; then
  GENIE_SPACE_ID="$(cat "$GENIE_STATE_FILE" 2>/dev/null || true)"
fi

_db() {
  databricks "$@" -p "$PROFILE"
}

_patch_object_group() {
  local api_path="$1"
  local group="$2"
  local level="$3"
  local payload
  payload="$(jq -nc --arg g "$group" --arg l "$level" \
    '{access_control_list: [{group_name: $g, permission_level: $l}]}')"
  if _db api patch "$api_path" --json "$payload" >/dev/null 2>&1; then
    _log "  ${api_path}: ${group} -> ${level}"
    return 0
  fi
  _warn "  ${api_path}: could not grant ${level} to '${group}' (group may not exist on this workspace)"
  return 1
}

_run_sql_grant() {
  local sql="$1"
  if _db experimental aitools tools query "$sql" >/dev/null 2>&1; then
    _log "  sql ok: ${sql}"
    return 0
  fi
  _warn "  sql skipped or failed: ${sql}"
  return 1
}

_log "profile=${PROFILE} catalog=${CATALOG} schema=${SCHEMA}"

# App service principal. The volume resource bindings in resources/app.yml
# stop at the volume, so table reads/writes (the UC mirror inserts in
# server/server.ts) need explicit schema-level privileges.
APP_SP_ID="$(_db apps get "$APP_NAME" -o json 2>/dev/null | jq -r '.service_principal_client_id // empty')"
if [[ -n "$APP_SP_ID" ]]; then
  _log "app service principal ${APP_SP_ID}"
  _run_sql_grant "GRANT USE CATALOG ON CATALOG \`${CATALOG}\` TO \`${APP_SP_ID}\`" || true
  _run_sql_grant "GRANT USE SCHEMA ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${APP_SP_ID}\`" || true
  _run_sql_grant "GRANT SELECT ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${APP_SP_ID}\`" || true
  _run_sql_grant "GRANT MODIFY ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${APP_SP_ID}\`" || true
  _run_sql_grant "GRANT CREATE TABLE ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${APP_SP_ID}\`" || true
  _run_sql_grant "GRANT READ VOLUME ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${APP_SP_ID}\`" || true
  _run_sql_grant "GRANT WRITE VOLUME ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`${APP_SP_ID}\`" || true
else
  _warn "could not resolve the ${APP_NAME} service principal; skipping app SP grants"
fi

# Genie Conversation API (dashboards.genie OBO scope).
if [[ -n "$GENIE_SPACE_ID" ]]; then
  _log "Genie space ${GENIE_SPACE_ID}"
  _patch_object_group "/api/2.0/permissions/genie/${GENIE_SPACE_ID}" "account users" "CAN_RUN" || true
  _patch_object_group "/api/2.0/permissions/genie/${GENIE_SPACE_ID}" "users" "CAN_RUN" || true
else
  _warn "no Genie space id (set GENIE_SPACE_ID or run deploy step 6 first); skipping Genie ACLs"
fi

# UC data Genie queries under the user's token (sql OBO scope).
_log "Unity Catalog ${CATALOG}.${SCHEMA} (workspace users)"
_run_sql_grant "GRANT USE CATALOG ON CATALOG \`${CATALOG}\` TO \`account users\`" || true
_run_sql_grant "GRANT USE SCHEMA ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`account users\`" || true
_run_sql_grant "GRANT SELECT ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`account users\`" || true
_run_sql_grant "GRANT READ VOLUME ON SCHEMA \`${CATALOG}\`.\`${SCHEMA}\` TO \`account users\`" || true

# Custom detector endpoints (serving.serving-endpoints OBO scope for listing;
# CAN_QUERY is still required per endpoint for invoke paths).
_log "LensIQ serving endpoints"
_endpoints_json="$(_db serving-endpoints list -o json 2>/dev/null || echo '[]')"
for _name in $LENSIQ_ENDPOINTS; do
  _eid="$(echo "$_endpoints_json" | jq -r --arg n "$_name" '.[] | select(.name == $n) | .id // empty' | head -n 1)"
  if [[ -z "$_eid" ]]; then
    _warn "  endpoint ${_name} not found yet (deploy jobs may still be pending)"
    continue
  fi
  _patch_object_group "/api/2.0/permissions/serving-endpoints/${_eid}" "account users" "CAN_QUERY" || true
done

_log "done"
