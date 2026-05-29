#!/usr/bin/env bash
# Mirror client/public/sample-videos/ into the bundle's `sample_videos`
# UC volume using `databricks sync` (incremental - unchanged MP4s are
# not re-uploaded).
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
set -euo pipefail

cd "$(dirname "$0")/.."

source "scripts/_sync-lib.sh"

sync_parse_target "$@"
sync_resolve_volume sample_videos
sync_run client/public/sample-videos "$VOLUME_PATH"
