#!/usr/bin/env bash
# Rewrite Unity Catalog catalog + schema references across the repo.
#
# Bundle YAML resolves `${var.catalog}` / `${var.schema}` from
# databricks.yml automatically; this script handles everything DABs
# can't reach:
#   - config/queries/*.sql                 (fully-qualified table refs)
#   - notebooks/*.ipynb                    (widget defaults)
#   - resources/genie_space_*.json         (Genie data_sources.tables)
#   - pipelines/pizza_vision_pipeline.py   (default Spark conf values)
#   - .env                                 (volume paths + DATABRICKS_CATALOG / DATABRICKS_SCHEMA)
#   - app.yaml                             (DATABRICKS_CATALOG / DATABRICKS_SCHEMA env values)
#   - databricks.yml                       (catalog / schema variable defaults)
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
#
# Run it from anywhere in the repo. After it returns, redeploy:
#   databricks bundle deploy -t dev
#   scripts/deploy.sh -t dev
set -euo pipefail

cd "$(dirname "$0")/.."

_NEW_CATALOG=""
_NEW_SCHEMA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --catalog) _NEW_CATALOG="$2"; shift 2 ;;
    --schema)  _NEW_SCHEMA="$2";  shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
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

if [[ "$_current_catalog" == "$_NEW_CATALOG" && "$_current_schema" == "$_NEW_SCHEMA" ]]; then
  echo "nothing to do: catalog=$_NEW_CATALOG schema=$_NEW_SCHEMA already set"
  exit 0
fi

_log() { printf "\033[1;34m[swap-uc]\033[0m %s\n" "$*"; }
_log "swapping catalog: $_current_catalog -> $_NEW_CATALOG"
_log "swapping schema:  $_current_schema  -> $_NEW_SCHEMA"

# `sed -i ''` is the macOS / BSD form, which also works on GNU sed when
# called via `sed -i.bak` if you ever port this to Linux. For now stick
# to macOS since the booth machine is darwin.
_sed() { sed -i '' "$@"; }

# 1. databricks.yml variable defaults.
_sed -E "/^  catalog:/,/default:/ s|default: ${_current_catalog}|default: ${_NEW_CATALOG}|" databricks.yml
_sed -E "/^  schema:/,/default:/  s|default: ${_current_schema}|default: ${_NEW_SCHEMA}|"  databricks.yml

# 2. .env (volume paths + DATABRICKS_CATALOG/SCHEMA).
_sed -E "s|/Volumes/${_current_catalog}/${_current_schema}/|/Volumes/${_NEW_CATALOG}/${_NEW_SCHEMA}/|g" .env
_sed -E "s|^DATABRICKS_CATALOG=.*|DATABRICKS_CATALOG=${_NEW_CATALOG}|"                                 .env
_sed -E "s|^DATABRICKS_SCHEMA=.*|DATABRICKS_SCHEMA=${_NEW_SCHEMA}|"                                    .env

# 3. app.yaml runtime env values.
_sed -E "/^  - name: DATABRICKS_CATALOG/,/value:/ s|value: ${_current_catalog}|value: ${_NEW_CATALOG}|" app.yaml
_sed -E "/^  - name: DATABRICKS_SCHEMA/,/value:/  s|value: ${_current_schema}|value: ${_NEW_SCHEMA}|"  app.yaml

# 4. SQL queries (fully-qualified table refs).
for f in config/queries/*.sql; do
  _sed -E "s|${_current_catalog}\.${_current_schema}\.|${_NEW_CATALOG}.${_NEW_SCHEMA}.|g" "$f"
done

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

_log "done. redeploy with:"
_log "  databricks bundle deploy -t dev"
_log "  scripts/deploy.sh -t dev"
