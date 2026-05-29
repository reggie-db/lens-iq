#!/usr/bin/env bash
# Mirror the booth-presenter content (talk-track markdown + standalone HTML
# deck) into the bundle's `presenter_content` UC volume using
# `databricks sync` (incremental - unchanged files are not re-uploaded).
#
# Only two files in docs/ belong in this volume (the rest of docs/ is
# unrelated), so we stage them into a tmp dir and sync that dir. Keeps
# the volume contents in lockstep with the staged file list - anything
# else previously in the volume gets removed by the incremental sync.
#
# The volume itself is declared in resources/volumes.yml so `databricks
# bundle deploy` creates it idempotently; this script just pushes the
# bytes. The local copies are excluded from the app source upload (see
# databricks.yml -> sync.exclude) so they only live on disk during dev
# and in this volume in prod - the app streams them back through
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

source "scripts/_sync-lib.sh"

# Files to mirror. Keep in sync with the PRESENTER_CONTENT map in
# server/server.ts - the id-to-filename mapping there is what the UI uses,
# and the file name has to match what's in the volume.
FILES=(
  "docs/dais-talk-track.md"
  "docs/booth-deck.html"
)

sync_parse_target "$@"
sync_resolve_volume presenter_content

# Stage into a persistent dir under .cache/ so `databricks sync` only
# sees these two files. The dir must be persistent (not mktemp) because
# `databricks sync` stores its incremental state under <src>/.databricks/
# - throwing the stage dir away on every run would force a full re-upload.
STAGE_DIR=".cache/sync-stage/presenter_content"
mkdir -p "$STAGE_DIR"

# Drop anything in the stage dir that isn't on the FILES list any more
# (keeps the volume contents in lockstep with the source list, and stops
# old files from being re-uploaded). The `.databricks` state dir is
# preserved by name.
shopt -s nullglob
keep=()
for f in "${FILES[@]}"; do keep+=("$(basename "$f")"); done
for existing in "$STAGE_DIR"/*; do
  name="$(basename "$existing")"
  [[ " ${keep[*]} " == *" $name "* ]] || rm -f "$existing"
done

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || _die "missing $f"
  # cp -p preserves mtime so `databricks sync` can skip unchanged files
  # on its second pass.
  cp -p "$f" "$STAGE_DIR/$(basename "$f")"
done

sync_run "$STAGE_DIR" "$VOLUME_PATH"
