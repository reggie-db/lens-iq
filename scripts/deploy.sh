#!/usr/bin/env bash
# One-shot deploy for LensIQ - safe to run against a brand-new workspace
# that has none of the catalog / schema / volumes / warehouse / Lakebase /
# secret-scope / app / jobs / pipeline / Genie space yet.
#
# The script is idempotent: every step either declares state via DABs (which
# is idempotent by definition) or wraps a CLI mutation in an existence check,
# so re-running it after the first deploy is a fast no-op for anything that's
# already there.
#
# Step ordering:
#   1. Source .env so DATABRICKS_CONFIG_PROFILE (and any operator-supplied
#      ROBOFLOW_API_KEY / PORTR_TOKEN) flow into the CLI.
#   2. `databricks bundle deploy` creates everything DABs supports:
#        UC catalog (retail_consumer_goods)
#        UC schema  (lens_iq)
#        UC volumes (frames, frames_inbox, sample_videos, presenter_content)
#        SQL warehouse (lensiq-warehouse)
#        Secret scope (lens-iq)
#        Lakebase Autoscaling project (lens-iq) + auto-provisioned production
#          branch + primary endpoint + databricks_postgres database
#        App resource bindings (warehouse, serving endpoints, postgres,
#          volumes, secret)
#        Jobs (seed + per-detector deploys + pipeline simulator)
#        Lakeflow Spark Declarative Pipeline.
#   3. `secrets put-secret` for roboflow_api_key + portr_token if the values
#      are present in env vars. Missing values skip with a warning so the
#      Roboflow detector deploy jobs are allowed to fail loudly later (the
#      app keeps working without them).
#   4. Push bytes into the bundle-owned volumes (sample videos, presenter
#      content). Wraps `databricks sync` via scripts/_sync-lib.sh.
#   5. Resolve the Lakebase endpoint + open the app schema to PUBLIC so the
#      app SP can write into it regardless of who created the schema first
#      (see scripts/grant-lakebase-schema.sh for the full rationale).
#   6. Re-create the LensIQ Detections Genie space from
#      resources/genie_space_lensiq_detections.json. DABs does not yet
#      declare genie spaces, so this is the one CLI step that isn't pure
#      `bundle deploy`. The resolved space id is cached at
#      .databricks/state/genie_space_id.
#   7. Run the deploy jobs in dependency order:
#        lens-iq-seed                         (synthetic data; opt-in via --seed)
#        pizza_vision_deploy_yolo             (YOLO endpoint)
#        lensiq_deploy_roboflow_detectors     (license plate + slip/fall)
#        lensiq_deploy_fog_detector           (Pillow+numpy classifier)
#        lensiq_deploy_face_recognition       (InsightFace buffalo_l)
#   8. `bundle run lens_iq` to push source code into the app and start it.
#
# Usage:
#   scripts/deploy.sh                    # full first-time deploy
#   scripts/deploy.sh -t dev             # explicit target
#   scripts/deploy.sh --seed             # opt in to step 5 (seed job).
#                                        # Off by default; pass it on a fresh
#                                        # workspace or to refresh the demo
#                                        # tables in <catalog>.<schema>.
#   scripts/deploy.sh --skip-jobs        # skip step 6b (per-detector model
#                                        # deploys). Does not affect --seed.
#   scripts/deploy.sh --skip-sync        # skip step 3 (volume sync)
#   scripts/deploy.sh --skip-grants      # skip step 4 (Lakebase grants)
#   scripts/deploy.sh --skip-genie       # skip step 6 (Genie space)
#   scripts/deploy.sh --skip-run         # skip step 7 (`bundle run`)
#   scripts/deploy.sh --bundle-only      # only run step 1 (`bundle deploy`)
#   scripts/deploy.sh --force-lock       # pass --force-lock to the
#                                        # `bundle deploy` invocation. Use
#                                        # when a prior run died mid-deploy
#                                        # and left the bundle lock acquired.
#
# Secrets (optional, read from env if set):
#   ROBOFLOW_API_KEY=...    pushed into lens-iq/roboflow_api_key
#   PORTR_TOKEN=...         pushed into lens-iq/portr_token
set -euo pipefail

cd "$(dirname "$0")/.."

# Source .env so DATABRICKS_CONFIG_PROFILE et al. are visible to the CLI. The
# Node.js side reads .env on its own via dotenv, but bash doesn't, so do it
# here. Only flip `set -a` for the source step itself.
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

TARGET="${TARGET:-}"
SKIP_SYNC=0
SKIP_GRANTS=0
SKIP_GENIE=0
SKIP_JOBS=0
RUN_SEED=0
SKIP_RUN=0
BUNDLE_ONLY=0
FORCE_LOCK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)   TARGET="$2"; shift 2 ;;
    --skip-sync)   SKIP_SYNC=1; shift ;;
    --skip-grants) SKIP_GRANTS=1; shift ;;
    --skip-genie)  SKIP_GENIE=1; shift ;;
    --skip-jobs)   SKIP_JOBS=1; shift ;;
    --seed)        RUN_SEED=1; shift ;;
    --skip-run)    SKIP_RUN=1; shift ;;
    --bundle-only) BUNDLE_ONLY=1; shift ;;
    --force-lock)  FORCE_LOCK=1; shift ;;
    -h|--help)     sed -n '2,69p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

_log()  { printf "\033[1;34m[deploy]\033[0m %s\n" "$*"; }
_warn() { printf "\033[1;33m[deploy]\033[0m %s\n" "$*" >&2; }
_fail() { printf "\033[1;31m[deploy]\033[0m %s\n" "$*" >&2; exit 1; }

# Pre-flight: verify the workspace-level resources the bundle expects to
# already exist (catalog + SQL warehouse). These are intentionally NOT
# bundle-owned because catalog creation requires metastore admin rights
# in most workspaces (Default Storage on managed metastores has a
# different create path) and warehouse creation requires
# workspace-admin. If they're missing, surface clear remediation up
# front instead of letting `bundle deploy` fail half-way through.
_preflight() {
  local catalog="${DATABRICKS_CATALOG:-retail_consumer_goods}"
  local wh_name="Serverless Starter Warehouse"
  _log "  pre-flight: catalog=${catalog}, warehouse=${wh_name}"
  if ! databricks catalogs get "$catalog" >/dev/null 2>&1; then
    _warn "  catalog '${catalog}' not found in this workspace."
    _warn "  Create it via the UI (Catalog Explorer -> Create catalog) or have an admin run:"
    _warn "    databricks catalogs create --json '{\"name\": \"${catalog}\"}'"
    _warn "  Then re-run scripts/deploy.sh."
    _fail "  aborting: catalog missing"
  fi
  if ! databricks warehouses list --output json 2>/dev/null \
      | jq -e --arg n "$wh_name" '.[] | select(.name == $n) | .id' >/dev/null; then
    _warn "  SQL warehouse '${wh_name}' not found."
    _warn "  Create a serverless PRO warehouse via the UI (SQL Warehouses -> Create)."
    _warn "  Or override the bundle var:"
    _warn "    databricks bundle deploy -t dev --var \"warehouse_id=<existing-id>\""
    _fail "  aborting: warehouse missing"
  fi
}

if [[ -n "$TARGET" ]]; then
  TARGET_FLAG=(-t "$TARGET")
  LABEL="-t $TARGET"
else
  TARGET_FLAG=()
  LABEL="(default target)"
fi

# Only `databricks bundle deploy` understands --force-lock. Splat the
# array into the deploy invocation (and the auto-bind retry inside
# _deploy_bundle) and nowhere else; passing it to `bundle run` or other
# CLI commands would 2-exit on an unknown flag.
if [[ "$FORCE_LOCK" -eq 1 ]]; then
  FORCE_LOCK_FLAG=(--force-lock)
  LABEL="${LABEL} --force-lock"
else
  FORCE_LOCK_FLAG=()
fi

# `${arr[@]+"${arr[@]}"}` is the bash workaround for `set -u` complaining
# about expanding an empty array. Use it everywhere we splat TARGET_FLAG.
_databricks() {
  databricks "$@" ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}
}

# Read a bundle variable's resolved value out of `bundle summary --output
# json`. Used to look up catalog / schema / warehouse_id / project info that
# was just declared by DABs without re-encoding the defaults here.
_bundle_var() {
  databricks bundle summary --output json ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"} 2>/dev/null \
    | jq -r ".variables.\"$1\".value // .variables.\"$1\".default // empty"
}

# Bundle resource key (resources/app.yml -> resources.apps.<KEY>) and the
# workspace-side app name DABs creates from it. Kept as constants because
# both are stable bundle-internal identifiers - if either drifts,
# `_deploy_bundle`'s auto-bind branch breaks loudly and we'd notice.
_BUNDLE_APP_KEY="lens_iq"
_WORKSPACE_APP_NAME="lens-iq"

# `bundle deploy` with auto-bind on ALREADY_EXISTS.
#
# DABs only knows about a workspace app it created itself. Common cases
# where the app exists but isn't tracked in the bundle state file:
#   - A teammate (or an earlier UI experiment) created the app first.
#   - The bundle state at .databricks/state/<target>/terraform.tfstate
#     was wiped or never made it to this checkout.
# In all of these, `bundle deploy` 409's on apps.${_BUNDLE_APP_KEY} with
# "Failed to create app <name>". The fix is `bundle deployment bind
# <bundle-key> <workspace-resource-id> --auto-approve`, then retry.
#
# Implementation note: we tee deploy output into a temp file so the
# caller still sees streaming progress AND we can grep the failure
# afterwards. set +e wraps the call so pipefail doesn't kill us before
# we get a chance to inspect the exit code.
_deploy_bundle() {
  local log_file
  log_file="$(mktemp -t dais-deploy.XXXXXX)"
  local rc=0
  set +e
  _databricks bundle deploy ${FORCE_LOCK_FLAG[@]+"${FORCE_LOCK_FLAG[@]}"} 2>&1 | tee "$log_file"
  rc=${PIPESTATUS[0]}
  set -e
  if [[ "$rc" -eq 0 ]]; then
    rm -f "$log_file"
    return 0
  fi
  if grep -qE "ALREADY_EXISTS.*${_WORKSPACE_APP_NAME}|Failed to create app ${_WORKSPACE_APP_NAME}" "$log_file"; then
    _log "  detected 409 on apps.${_BUNDLE_APP_KEY} -> binding existing workspace app '${_WORKSPACE_APP_NAME}'"
    rm -f "$log_file"
    _databricks bundle deployment bind "$_BUNDLE_APP_KEY" "$_WORKSPACE_APP_NAME" \
      ${FORCE_LOCK_FLAG[@]+"${FORCE_LOCK_FLAG[@]}"} --auto-approve
    _log "  retrying bundle deploy after bind"
    _databricks bundle deploy ${FORCE_LOCK_FLAG[@]+"${FORCE_LOCK_FLAG[@]}"}
    return 0
  fi
  rm -f "$log_file"
  return "$rc"
}

# ─── 1. Bundle deploy (schema/volumes/secret-scope/lakebase/jobs/pipeline + app) ──
# Deploys the whole bundle, including the app, exactly as resources/app.yml
# is committed - no on-disk app.yml staging or rewriting. The app's resource
# bindings reference per-detector serving endpoints by name; DABs validates
# those at deploy time, so this assumes the bound endpoints + secrets already
# exist in the target workspace (true on a re-deploy). The endpoint deploy
# jobs (step 6) and `bundle run` (step 7) then refresh models + start the app.
_log "[1/8] bundle deploy $LABEL (schema/volumes/secret-scope/lakebase/jobs/pipeline + app)"
_preflight
_deploy_bundle

if [[ "$BUNDLE_ONLY" -eq 1 ]]; then
  _log "bundle-only mode: stopping after the bundle deploy. Re-run without --bundle-only to finish."
  exit 0
fi

# Resolved bundle values used by the rest of the script.
SECRET_SCOPE="$(_bundle_var secret_scope)"
SECRET_SCOPE="${SECRET_SCOPE:-lens-iq}"
ROBOFLOW_KEY_NAME="$(_bundle_var roboflow_secret_key)"
ROBOFLOW_KEY_NAME="${ROBOFLOW_KEY_NAME:-roboflow_api_key}"
PORTR_KEY_NAME="$(_bundle_var apps_tunnel_secret_key)"
PORTR_KEY_NAME="${PORTR_KEY_NAME:-portr_token}"
WAREHOUSE_ID="$(_bundle_var warehouse_id)"

# ─── 2. Secrets ──────────────────────────────────────────────────────────
_log "[2/8] secrets put-secret (scope=${SECRET_SCOPE})"
_put_secret() {
  local key="$1" value="$2" label="$3"
  if [[ -z "$value" ]]; then
    _warn "  ${label}: env var empty - skipping put-secret. The downstream consumer (deploy job or public tunnel) will fail loudly if it's required."
    return
  fi
  printf "%s" "$value" \
    | databricks secrets put-secret "$SECRET_SCOPE" "$key" --string-value "$value" >/dev/null
  _log "  ${label}: stored in ${SECRET_SCOPE}/${key}"
}
_put_secret "$ROBOFLOW_KEY_NAME" "${ROBOFLOW_API_KEY:-}" "ROBOFLOW_API_KEY"
_put_secret "$PORTR_KEY_NAME"    "${PORTR_TOKEN:-}"     "PORTR_TOKEN"

# ─── 3. Volume sync (sample videos + presenter content) ──────────────────
if [[ "$SKIP_SYNC" -eq 0 ]]; then
  _log "[3/8] sync sample-videos + presenter-content into UC volumes"
  scripts/sync-sample-videos.sh     ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}
  scripts/sync-presenter-content.sh ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}
else
  _log "[3/8] sync skipped (--skip-sync)"
fi

# ─── 4. Lakebase schema grants ───────────────────────────────────────────
if [[ "$SKIP_GRANTS" -eq 0 ]]; then
  _log "[4/8] grant Lakebase schema to PUBLIC"
  scripts/grant-lakebase-schema.sh
else
  _log "[4/8] grants skipped (--skip-grants)"
fi

# ─── 5. Seed demo tables (opt-in) ────────────────────────────────────────
# Off by default - the demo tables persist across deploys, so a re-deploy
# rarely needs to re-seed. Pass --seed on a fresh workspace (or to refresh
# the synthetic data); the Genie space (step 6) and the app's analytics
# pages then read from these tables. The seed job is parameterized with the
# bundle catalog/schema vars so it lands in the right place.
_run_job() {
  local job="$1"
  _log "  databricks bundle run ${job} ${LABEL}"
  _databricks bundle run "$job"
}

if [[ "$RUN_SEED" -eq 1 ]]; then
  _log "[5/8] bundle run lens-iq-seed (creates demo tables in ${DATABRICKS_CATALOG:-retail_consumer_goods}.${DATABRICKS_SCHEMA:-lens_iq})"
  _run_job lens-iq-seed
else
  _log "[5/8] seed job skipped (pass --seed to run it)"
fi

# ─── 6. Genie space ──────────────────────────────────────────────────────
# DABs does not yet declare genie_spaces, so this is the one out-of-band
# step that wraps a CLI call in an existence check. State is cached at
# `.databricks/state/genie_space_id` to make re-runs free.
GENIE_STATE_DIR=".databricks/state"
GENIE_STATE_FILE="${GENIE_STATE_DIR}/genie_space_id"
GENIE_CONFIG="resources/genie_space_lensiq_detections.json"

if [[ "$SKIP_GENIE" -eq 0 ]]; then
  _log "[6/8] Genie space (warehouse=${WAREHOUSE_ID})"
  mkdir -p "$GENIE_STATE_DIR"
  _existing_id=""
  if [[ -f "$GENIE_STATE_FILE" ]]; then
    _existing_id="$(cat "$GENIE_STATE_FILE" 2>/dev/null || true)"
  fi

  _space_alive=0
  if [[ -n "$_existing_id" ]]; then
    if databricks genie get-space "$_existing_id" >/dev/null 2>&1; then
      _space_alive=1
    fi
  fi

  [[ -f "$GENIE_CONFIG" ]] || _fail "  ${GENIE_CONFIG} missing"

  # Filter the config down to tables that actually exist in the workspace.
  # Genie 4xx's if any referenced table is missing. `pipeline_frames` is
  # created by the running Lakeflow pipeline (resources/pipeline.yml) once
  # it starts producing rows; on a fresh deploy it doesn't exist yet.
  # Anything filtered out is re-added on the next deploy after the
  # missing tables come into existence.
  _payload="$(python3 - "$GENIE_CONFIG" "${DATABRICKS_CATALOG:-retail_consumer_goods}" "${DATABRICKS_SCHEMA:-lens_iq}" <<'PY'
import json, subprocess, sys
path, catalog, schema = sys.argv[1:4]
with open(path) as f:
    cfg = json.load(f)
tables = cfg.get("data_sources", {}).get("tables", [])
def exists(ident):
    return subprocess.run(["databricks", "tables", "get", ident],
                          capture_output=True).returncode == 0
keep = [t for t in tables if exists(t["identifier"])]
cfg.setdefault("data_sources", {})["tables"] = keep
print(json.dumps(cfg))
PY
)"

  if [[ "$_space_alive" -eq 1 ]]; then
    # Push the current JSON into the live space so edits to instructions /
    # sample questions / curated SQL examples / table descriptions take
    # effect on every deploy without manual recreation. update-space does a
    # full replacement of the serialized space content.
    #
    # Do NOT pass --title here. `update-space --title X` re-registers the
    # space's parent-folder node with the new name, which fails with
    # "Node named 'X' already exists" when X matches the space's current
    # name (always, in our case). Title is set once at create time and
    # any rename is a manual operator action; this script never renames.
    _log "  updating existing space ${_existing_id} from ${GENIE_CONFIG}"
    databricks genie update-space "$_existing_id" \
      --serialized-space "$_payload" \
      --warehouse-id "$WAREHOUSE_ID" \
      --output json >/dev/null
    _log "  updated Genie space ${_existing_id}"
  else
    [[ -n "$WAREHOUSE_ID" ]] || _fail "  cannot resolve warehouse_id - bundle deploy may have failed"
    _log "  creating Genie space from ${GENIE_CONFIG}"
    _new_id="$(databricks genie create-space "$WAREHOUSE_ID" "$_payload" \
      --title "LensIQ Detections" \
      --output json | jq -r '.space_id // .id // empty')"
    if [[ -z "$_new_id" ]]; then
      _fail "  Genie create-space returned no space id"
    fi
    printf "%s" "$_new_id" > "$GENIE_STATE_FILE"
    _log "  created Genie space ${_new_id} -> ${GENIE_STATE_FILE}"
  fi
else
  _log "[6/8] Genie space skipped (--skip-genie)"
fi

# ─── 6b. Endpoint deploy jobs (YOLO + Roboflow + fog + face) ─────────────
# These each register a new UC model + ship a serving endpoint. Phase 2
# of the bundle deploy (step 7) binds the app to those endpoints, so they
# must finish first. Each job is ~3-5 minutes (cold-start endpoint
# provisioning). All four can run in parallel from the API side, but
# `bundle run` is synchronous, so we run them serially.
#
# Idempotency: the deploy notebooks try to handle "endpoint exists" but
# can race (the `serving_endpoints.get` exception clause is too broad).
# Sidestep by checking endpoint readiness here and skipping the job
# entirely when the endpoint already serves the right traffic.
_endpoint_ready() {
  local name="$1"
  databricks serving-endpoints list --output json 2>/dev/null \
    | jq -e --arg n "$name" '.[]? | select(.name == $n and .state.ready == "READY")' >/dev/null
}
_run_job_if_endpoint_missing() {
  local job="$1" endpoint="$2"
  if _endpoint_ready "$endpoint"; then
    _log "  ${job}: endpoint ${endpoint} already READY - skipping"
  else
    _run_job "$job"
  fi
}

if [[ "$SKIP_JOBS" -eq 0 ]]; then
  _log "[6/8] running per-detector deploy jobs (~10 min total on first deploy)"
  _run_job_if_endpoint_missing pizza_vision_deploy_yolo lensiq-detector
  if [[ -n "${ROBOFLOW_API_KEY:-}" ]]; then
    if _endpoint_ready lensiq-license-plate && _endpoint_ready lensiq-slip-fall; then
      _log "  lensiq_deploy_roboflow_detectors: both endpoints already READY - skipping"
    else
      _run_job lensiq_deploy_roboflow_detectors
    fi
  else
    _warn "  ROBOFLOW_API_KEY not set - skipping lensiq_deploy_roboflow_detectors"
    _warn "  License plate + slip/fall pages will show 'endpoint not deployed' until you re-run with the key set."
  fi
  _run_job_if_endpoint_missing lensiq_deploy_fog_detector       lensiq-fog-detector
  # Face recognition is opt-in (DEPLOY_FACE_RECOGNITION=1). The default
  # deploy skips it because notebooks/deploy_face_recognition.ipynb's
  # buffalo_l zip extraction is currently flaky on serverless. The
  # app.yml face_recognition binding is also commented out by default;
  # uncomment both after the deploy notebook is fixed.
  if [[ -n "${DEPLOY_FACE_RECOGNITION:-}" ]]; then
    _run_job_if_endpoint_missing lensiq_deploy_face_recognition lensiq-face-recognition
  else
    _warn "  DEPLOY_FACE_RECOGNITION not set - skipping lensiq_deploy_face_recognition."
    _warn "  Facial Recognition page will show 'endpoint not deployed' until you fix the notebook + set DEPLOY_FACE_RECOGNITION=1 on re-run."
  fi
else
  _log "[6/8] endpoint deploy jobs skipped (--skip-jobs)"
fi

# ─── 7. Start the app ────────────────────────────────────────────────────
# The app resource + source were already created/pushed by the bundle deploy
# in step 1. Now that the per-detector endpoints exist (step 6), start the
# app so it picks them up.
if [[ "$SKIP_RUN" -eq 0 ]]; then
  _log "[7/8] bundle run lens_iq ${LABEL}"
  _databricks bundle run lens_iq
else
  _log "[7/8] app start skipped (--skip-run)"
fi

# ─── 8. Done ─────────────────────────────────────────────────────────────
_log "[8/8] deploy complete."
_log "If this was a fresh workspace, the app is now reachable at its workspace URL."
_log "Re-run scripts/deploy.sh after any code or YAML change; every step is idempotent."
