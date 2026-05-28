#!/usr/bin/env bash
# Mirror the booth-presenter content (talk-track markdown + standalone HTML
# deck) into the bundle's `presenter_content` UC volume.
#
# The volume itself is declared in resources/volumes.yml so `databricks
# bundle deploy` creates it idempotently; this script just pushes the
# bytes. The local copies are excluded from the app source upload (see
# databricks.yml -> sync.exclude) so they only ever live on disk during
# dev and in this volume in prod - the app streams them back through
# /api/presenter-content/:id.
#
# Re-run any time the talk track or deck changes; no app redeploy is
# needed for the UI to pick up the new copy on the next page load
# (Cache-Control on the route is no-store).
#
# Usage:
#   scripts/sync-presenter-content.sh                # uses default target
#   scripts/sync-presenter-content.sh -t dev         # explicit target
#   TARGET=dev scripts/sync-presenter-content.sh     # env override
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${TARGET:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

_log() { printf "\033[1;34m[sync-presenter-content]\033[0m %s\n" "$*"; }
_die() { printf "\033[1;31m[sync-presenter-content]\033[0m %s\n" "$*" >&2; exit 1; }

if [[ -n "$TARGET" ]]; then
  SUMMARY_JSON="$(databricks bundle summary -t "$TARGET" --output json)"
else
  SUMMARY_JSON="$(databricks bundle summary --output json)"
fi

TARGET_NAME="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("bundle",{}).get("target","?"))')"
PROFILE="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("workspace",{}).get("profile",""))')"
CATALOG="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["variables"]["catalog"]["value"])')"
SCHEMA="$(printf '%s' "$SUMMARY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["variables"]["schema"]["value"])')"

if [[ -z "$CATALOG" || -z "$SCHEMA" ]]; then
  _die "could not resolve catalog/schema from bundle summary (target=$TARGET_NAME)"
fi

VOLUME_PATH="/Volumes/${CATALOG}/${SCHEMA}/presenter_content"

# Files to mirror. Keep in sync with the PRESENTER_CONTENT map in
# server/server.ts - the id-to-filename mapping there is what the UI uses,
# and the file name has to match what's in the volume.
FILES=(
  "docs/dais-talk-track.md"
  "docs/booth-deck.html"
)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || _die "missing $f"
done

_log "target=$TARGET_NAME profile=${PROFILE:-<default>} → dbfs:$VOLUME_PATH"
_log "uploading ${#FILES[@]} files…"

if [[ -n "$PROFILE" ]]; then
  PROFILE_FLAG=(--profile "$PROFILE")
else
  PROFILE_FLAG=()
fi

for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  databricks fs cp "$f" "dbfs:${VOLUME_PATH}/${base}" --overwrite ${PROFILE_FLAG[@]+"${PROFILE_FLAG[@]}"} >/dev/null
  _log "  + ${base}"
done

_log "done."
