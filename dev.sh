#!/usr/bin/env bash
# dev.sh - one-shot local dev loop for the pizza-vision-app.
#
# Validates prerequisites (node, databricks CLI, auth), installs node deps
# only if missing, verifies the workspace-side resources the app talks to
# (warehouse, YOLO endpoint, volume), then launches `npm run dev`.
#
# Flags:
#   --seed       run `pizza_vision_seed` bundle job before starting (creates
#                catalog/schema/volumes/tables).
#   --deploy-yolo  run `pizza_vision_deploy_yolo` bundle job (builds + serves
#                  the YOLO detector model).
#   --pipeline   start the continuous pipeline + simulator on the workspace
#                in the background so the Pipeline page has live data.
#   --skip-checks  skip preflight resource verification (faster boot if you
#                  know the workspace is already set up).
#   --no-install   skip `npm install` even if node_modules is missing.
#
# Usage:
#   ./dev.sh                       # plain dev loop, assumes setup done
#   ./dev.sh --seed --deploy-yolo  # first time on a fresh workspace
#   ./dev.sh --pipeline            # also start the SDP + simulator
set -euo pipefail

cd "$(dirname "$0")"

# --- arg parsing -------------------------------------------------------------
DO_SEED=0
DO_DEPLOY_YOLO=0
DO_PIPELINE=0
SKIP_CHECKS=0
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --seed) DO_SEED=1 ;;
    --deploy-yolo) DO_DEPLOY_YOLO=1 ;;
    --pipeline) DO_PIPELINE=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# --- helpers -----------------------------------------------------------------
_log() { printf "\033[1;34m[dev]\033[0m %s\n" "$*"; }
_warn() { printf "\033[1;33m[dev]\033[0m %s\n" "$*" >&2; }
_die() { printf "\033[1;31m[dev]\033[0m %s\n" "$*" >&2; exit 1; }

_need() { command -v "$1" >/dev/null 2>&1 || _die "missing required tool: $1"; }

# --- preflight: tools --------------------------------------------------------
_need node
_need npm
_need databricks

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[[ "$NODE_MAJOR" -ge 22 ]] || _die "node >= 22 required (found $(node -v))"

# --- preflight: .env ---------------------------------------------------------
[[ -f .env ]] || _die ".env not found - copy from .env.example or check git"
set -a
. ./.env
set +a
PROFILE="${DATABRICKS_CONFIG_PROFILE:-DEFAULT}"

# --- preflight: databricks auth ---------------------------------------------
if ! databricks current-user me --profile "$PROFILE" >/dev/null 2>&1; then
  _warn "profile $PROFILE not authenticated - running \`databricks auth login\`"
  databricks auth login --profile "$PROFILE"
fi
WHOAMI="$(databricks current-user me --profile "$PROFILE" --output json | python3 -c 'import json,sys; print(json.load(sys.stdin)["userName"])')"
_log "authenticated as $WHOAMI (profile=$PROFILE)"

# --- node deps ---------------------------------------------------------------
if [[ ! -d node_modules && "$NO_INSTALL" -eq 0 ]]; then
  _log "installing node modules (no lockfile by design - resolves against registry.npmjs.org)"
  npm install --no-package-lock
fi

# --- optional one-shot bundle jobs ------------------------------------------
if [[ "$DO_SEED" -eq 1 ]]; then
  _log "running pizza_vision_seed (catalog/schema/volumes/tables)"
  databricks bundle run pizza_vision_seed -t dev
fi

if [[ "$DO_DEPLOY_YOLO" -eq 1 ]]; then
  _log "running pizza_vision_deploy_yolo (model serving endpoint, ~5 min cold start)"
  databricks bundle run pizza_vision_deploy_yolo -t dev
fi

if [[ "$DO_PIPELINE" -eq 1 ]]; then
  _log "deploying continuous pipeline + starting simulator (async, output in /tmp)"
  databricks bundle deploy -t dev >/tmp/pizza-vision-deploy.log 2>&1
  databricks bundle run pizza_vision_pipeline -t dev >/tmp/pizza-vision-pipeline.log 2>&1 &
  databricks bundle run pizza_vision_simulate -t dev >/tmp/pizza-vision-simulate.log 2>&1 &
fi

# --- preflight: workspace resources ------------------------------------------
if [[ "$SKIP_CHECKS" -eq 0 ]]; then
  _log "checking workspace resources"

  databricks warehouses get "${DATABRICKS_WAREHOUSE_ID}" --profile "$PROFILE" >/dev/null 2>&1 \
    || _warn "SQL warehouse ${DATABRICKS_WAREHOUSE_ID} not reachable - analytics queries will fail"

  if ! databricks serving-endpoints get "${DATABRICKS_SERVING_ENDPOINT_DETECTOR}" --profile "$PROFILE" >/dev/null 2>&1; then
    _warn "detector endpoint ${DATABRICKS_SERVING_ENDPOINT_DETECTOR} missing - rerun with --deploy-yolo"
  fi

  if ! databricks volumes read "${DATABRICKS_VOLUME_FRAMES#/Volumes/}" --profile "$PROFILE" >/dev/null 2>&1 \
    && ! databricks fs ls "dbfs:${DATABRICKS_VOLUME_FRAMES}" --profile "$PROFILE" >/dev/null 2>&1; then
    _warn "frames volume ${DATABRICKS_VOLUME_FRAMES} not found - rerun with --seed"
  fi
fi

# --- run ---------------------------------------------------------------------
_log "starting dev server on http://localhost:8000 (Ctrl+C to stop)"
exec npm run dev
