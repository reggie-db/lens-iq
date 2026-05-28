#!/usr/bin/env bash
# One-shot deploy wrapper for lens-iq.
#
# Sequences the steps that DABs alone can't compose:
#   1. `databricks bundle deploy` to create UC volumes / app / job resources
#      and upload the bundled source files.
#   2. `scripts/sync-sample-videos.sh` to push client/public/sample-videos/
#      MP4s into the bundle-managed sample_videos UC volume (the bundle
#      excludes those bytes from the app source so they only live on the
#      volume in prod).
#   3. `scripts/sync-presenter-content.sh` to push docs/dais-talk-track.md
#      and docs/booth-deck.html into the presenter_content UC volume. The
#      InfoPage reads from this volume at runtime so updates to the
#      narrative don't require an app redeploy - re-run the sync script
#      alone and reload the page.
#   4. `databricks bundle run lens_iq` to push source code into the app and
#      start it.
#
# Defaults to the bundle's default target (`dev`). Override with -t or
# the TARGET env var. Authentication resolves from the workspace `host:`
# pinned in databricks.yml against ~/.databrickscfg, or from
# DATABRICKS_HOST/DATABRICKS_TOKEN env vars, or from -p <profile>.
#
# Usage:
#   scripts/deploy.sh                # → dev (default)
#   scripts/deploy.sh -t dev         # → dev (explicit)
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${TARGET:-}"
SKIP_SYNC=0
SKIP_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) TARGET="$2"; shift 2 ;;
    --skip-sync) SKIP_SYNC=1; shift ;;
    --skip-run) SKIP_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

_log() { printf "\033[1;34m[deploy]\033[0m %s\n" "$*"; }

if [[ -n "$TARGET" ]]; then
  TARGET_FLAG=(-t "$TARGET")
  LABEL="-t $TARGET"
else
  TARGET_FLAG=()
  LABEL="(default target)"
fi

_log "bundle deploy $LABEL"
databricks bundle deploy ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}

if [[ "$SKIP_SYNC" -eq 0 ]]; then
  _log "sync-sample-videos.sh $LABEL"
  scripts/sync-sample-videos.sh ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}
  _log "sync-presenter-content.sh $LABEL"
  scripts/sync-presenter-content.sh ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}
fi

if [[ "$SKIP_RUN" -eq 0 ]]; then
  _log "bundle run lens_iq $LABEL"
  databricks bundle run lens_iq ${TARGET_FLAG[@]+"${TARGET_FLAG[@]}"}
fi

_log "deploy complete."
