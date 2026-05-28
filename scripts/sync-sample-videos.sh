#!/usr/bin/env bash
# Mirror every client/public/sample-videos/*.mp4 into the bundle's
# `sample_videos` UC volume.
#
# The volume itself is declared in resources/volumes.yml so `databricks
# bundle deploy` creates it idempotently; this script just pushes the
# bytes. The local MP4s are excluded from the app source upload (see
# databricks.yml -> sync.exclude) so they only ever live on disk during
# dev and in this volume in prod - the AppKit files plugin streams them
# back through /api/files/sample_videos/raw?path=<file>.
#
# Usage:
#   scripts/sync-sample-videos.sh                    # uses default target
#   scripts/sync-sample-videos.sh -t dev             # explicit target
#   TARGET=dev scripts/sync-sample-videos.sh         # env override
#
# Resolves catalog/schema from `databricks bundle summary` so the script
# stays correct as targets and overrides change.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${TARGET:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

_log() { printf "\033[1;34m[sync-sample-videos]\033[0m %s\n" "$*"; }
_die() { printf "\033[1;31m[sync-sample-videos]\033[0m %s\n" "$*" >&2; exit 1; }

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

VOLUME_PATH="/Volumes/${CATALOG}/${SCHEMA}/sample_videos"
SRC_DIR="client/public/sample-videos"

[[ -d "$SRC_DIR" ]] || _die "missing $SRC_DIR"

shopt -s nullglob
FILES=("$SRC_DIR"/*.mp4)
[[ ${#FILES[@]} -gt 0 ]] || _die "no MP4s under $SRC_DIR"

_log "target=$TARGET_NAME profile=${PROFILE:-<default>} → dbfs:$VOLUME_PATH"
_log "uploading ${#FILES[@]} files…"

# CLI flag form: pass --profile only when bundle summary actually returned one
# (avoids `--profile ''` which the CLI rejects). Use the +"${arr[@]}" idiom so
# `set -u` doesn't trip on the empty-array case.
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
