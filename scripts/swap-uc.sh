#!/usr/bin/env bash
# Rewrite Unity Catalog catalog + schema references across the repo.
#
# Bundle YAML resolves `${var.catalog}` / `${var.schema}` from
# databricks.yml automatically; this script handles the static files DABs
# can't reach:
#   - notebooks/*.ipynb                    (widget defaults)
#   - resources/genie_space_*.json         (Genie data_sources.tables)
#   - pipelines/pizza_vision_pipeline.py   (default Spark conf values)
#   - .env                                 (volume paths + DATABRICKS_CATALOG /
#                                            DATABRICKS_SCHEMA + BUNDLE_VAR_catalog)
#   - app.yaml                             (DATABRICKS_CATALOG / DATABRICKS_SCHEMA env values)
#   - databricks.yml                       (catalog / schema variable defaults)
#
# Genie space ID is per-workspace (not a catalog/schema ref), so it is only
# rewritten when you pass the optional --genie-space-id. When given, it is
# written to .env (DATABRICKS_GENIE_SPACE_ID), app.yaml (the env value),
# databricks.yml (variables.genie_space_id default), and the deploy state
# cache at .databricks/state/genie_space_id that scripts/deploy.sh reads.
#
# It does NOT touch config/queries/*.sql.tmpl - those carry `${catalog}` /
# `${schema}` placeholders that server/uc.ts renders at app boot from the
# DATABRICKS_CATALOG / DATABRICKS_SCHEMA env vars (set in app.yaml from the
# values this script writes). So for the app's analytics queries, updating
# .env / app.yaml here is enough; no per-query rewrite is needed.
#
# It does NOT touch:
#   - Bundle resource IDs (e.g. `lens-iq-seed`, `lensiq_deploy_*`).
#   - Serving endpoint names (`lensiq-*`).
#   - The `pizza_vision.*` Spark conf key prefix in resources/pipeline.yml.
#   - Any *.lensiq.* model registration paths or *lensiq-* identifiers.
# Those are name spaces that aren't UC catalog/schema and can stay put
# unless you explicitly want to rename them.
#
# Usage:
#   scripts/swap-uc.sh --catalog new_catalog --schema new_schema
#   scripts/swap-uc.sh --catalog new_catalog --schema new_schema \
#                      --genie-space-id 01f1612738d51ed591447062305e769b
#
# Run it from anywhere in the repo. After it returns, redeploy:
#   databricks bundle deploy -t dev
#   scripts/deploy.sh -t dev
set -euo pipefail

cd "$(dirname "$0")/.."

_NEW_CATALOG=""
_NEW_SCHEMA=""
_NEW_GENIE_SPACE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --catalog)         _NEW_CATALOG="$2";         shift 2 ;;
    --schema)          _NEW_SCHEMA="$2";          shift 2 ;;
    --genie-space-id)  _NEW_GENIE_SPACE_ID="$2";  shift 2 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "$_NEW_CATALOG" || -z "$_NEW_SCHEMA" ]]; then
  echo "Both --catalog and --schema are required" >&2
  echo "  scripts/swap-uc.sh --catalog <name> --schema <name>" >&2
  exit 2
fi

# Discover the current UC target from databricks.yml so we know what to
# replace. Parsed via grep + awk to avoid pulling in a YAML dep.
_current_catalog=$(awk '/^  catalog:/{f=1} f&&/default:/{print $2; exit}' databricks.yml)
_current_schema=$(awk '/^  schema:/{f=1} f&&/default:/{print $2; exit}' databricks.yml)

if [[ -z "$_current_catalog" || -z "$_current_schema" ]]; then
  echo "could not parse current catalog/schema from databricks.yml" >&2
  exit 1
fi

# Only bail when there is genuinely nothing to do: catalog + schema already
# match AND no genie-space-id rewrite was requested. A genie-only swap (same
# catalog/schema, new --genie-space-id) still has work to do.
if [[ "$_current_catalog" == "$_NEW_CATALOG" && "$_current_schema" == "$_NEW_SCHEMA" \
      && -z "$_NEW_GENIE_SPACE_ID" ]]; then
  echo "nothing to do: catalog=$_NEW_CATALOG schema=$_NEW_SCHEMA already set"
  exit 0
fi

_log() { printf "\033[1;34m[swap-uc]\033[0m %s\n" "$*"; }
_log "swapping catalog: $_current_catalog -> $_NEW_CATALOG"
_log "swapping schema:  $_current_schema  -> $_NEW_SCHEMA"
[[ -n "$_NEW_GENIE_SPACE_ID" ]] && _log "swapping genie:   -> $_NEW_GENIE_SPACE_ID"

# `sed -i ''` is the macOS / BSD form, which also works on GNU sed when
# called via `sed -i.bak` if you ever port this to Linux. For now stick
# to macOS since the booth machine is darwin.
_sed() { sed -i '' "$@"; }

# 1. databricks.yml variable defaults.
_sed -E "/^  catalog:/,/default:/ s|default: ${_current_catalog}|default: ${_NEW_CATALOG}|" databricks.yml
_sed -E "/^  schema:/,/default:/  s|default: ${_current_schema}|default: ${_NEW_SCHEMA}|"  databricks.yml

# 2. .env (volume paths + DATABRICKS_CATALOG/SCHEMA + BUNDLE_VAR_catalog).
#    BUNDLE_VAR_catalog overrides the databricks.yml default at deploy time
#    (env vars beat defaults in DABs variable precedence), so it MUST track
#    the catalog too or `bundle deploy` lands in the wrong catalog.
_sed -E "s|/Volumes/${_current_catalog}/${_current_schema}/|/Volumes/${_NEW_CATALOG}/${_NEW_SCHEMA}/|g" .env
_sed -E "s|^DATABRICKS_CATALOG=.*|DATABRICKS_CATALOG=${_NEW_CATALOG}|"                                 .env
_sed -E "s|^DATABRICKS_SCHEMA=.*|DATABRICKS_SCHEMA=${_NEW_SCHEMA}|"                                    .env
_sed -E "s|^BUNDLE_VAR_catalog=.*|BUNDLE_VAR_catalog=${_NEW_CATALOG}|"                                 .env

# 3. app.yaml runtime env values.
_sed -E "/^  - name: DATABRICKS_CATALOG/,/value:/ s|value: ${_current_catalog}|value: ${_NEW_CATALOG}|" app.yaml
_sed -E "/^  - name: DATABRICKS_SCHEMA/,/value:/  s|value: ${_current_schema}|value: ${_NEW_SCHEMA}|"  app.yaml

# 4. SQL queries: nothing to do. config/queries/*.sql.tmpl use
#    `${catalog}` / `${schema}` placeholders rendered at app boot by
#    server/uc.ts from DATABRICKS_CATALOG / DATABRICKS_SCHEMA (step 3).

# 5. Genie space JSON.
for f in resources/genie_space_*.json; do
  [[ -f "$f" ]] || continue
  _sed -E "s|${_current_catalog}\.${_current_schema}\.|${_NEW_CATALOG}.${_NEW_SCHEMA}.|g" "$f"
done

# 6. Notebook widget defaults. The widgets are quoted JSON strings, so
# the escapes look weird but are correct for an embedded .ipynb cell.
for f in notebooks/*.ipynb; do
  _sed -E "s|widgets.text\\(\\\\\"catalog\\\\\", \\\\\"${_current_catalog}\\\\\"\\)|widgets.text(\\\\\"catalog\\\\\", \\\\\"${_NEW_CATALOG}\\\\\")|g" "$f"
  _sed -E "s|widgets.text\\(\\\\\"schema\\\\\", \\\\\"${_current_schema}\\\\\"\\)|widgets.text(\\\\\"schema\\\\\", \\\\\"${_NEW_SCHEMA}\\\\\")|g"   "$f"
done

# 7. Lakeflow pipeline defaults.
_sed -E "s|spark.conf.get\\(\"pizza_vision.catalog\", \"${_current_catalog}\"\\)|spark.conf.get(\"pizza_vision.catalog\", \"${_NEW_CATALOG}\")|" pipelines/pizza_vision_pipeline.py
_sed -E "s|spark.conf.get\\(\"pizza_vision.schema\", \"${_current_schema}\"\\)|spark.conf.get(\"pizza_vision.schema\", \"${_NEW_SCHEMA}\")|"     pipelines/pizza_vision_pipeline.py

# 8. Genie space ID (optional, per-workspace). Rewritten only when
#    --genie-space-id is supplied. Replaces by line anchor (not old value)
#    so it works regardless of what was there before, across .env, app.yaml,
#    databricks.yml, and the deploy state cache scripts/deploy.sh reads.
if [[ -n "$_NEW_GENIE_SPACE_ID" ]]; then
  _sed -E "s|^DATABRICKS_GENIE_SPACE_ID=.*|DATABRICKS_GENIE_SPACE_ID=${_NEW_GENIE_SPACE_ID}|" .env
  _sed -E "/- name: DATABRICKS_GENIE_SPACE_ID/,/value:/ s|value: .*|value: ${_NEW_GENIE_SPACE_ID}|" app.yaml
  _sed -E "/^  genie_space_id:/,/default:/ s|default: .*|default: \"${_NEW_GENIE_SPACE_ID}\"|" databricks.yml
  mkdir -p .databricks/state
  printf "%s" "$_NEW_GENIE_SPACE_ID" > .databricks/state/genie_space_id
fi

_log "done. redeploy with:"
_log "  databricks bundle deploy -t dev"
_log "  scripts/deploy.sh -t dev"
