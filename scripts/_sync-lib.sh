# Shared helpers for scripts/sync-*.sh.
#
# Source from a sibling script:
#
#   source "$(dirname "$0")/_sync-lib.sh"
#   sync_parse_target "$@"
#   sync_resolve_volume sample_videos
#   sync_run "$LOCAL_DIR" "$VOLUME_PATH"
#
# Each sync_* helper sets shell vars in the caller; see the function
# headers for what each one writes.
#
# Not standalone - has no shebang and no `set -e` so the caller stays in
# charge of error handling.

# Caller-provided label used in log lines. Default to the script's basename
# (minus .sh) so e.g. sync-sample-videos.sh shows "[sync-sample-videos]".
SYNC_LIB_LABEL="${SYNC_LIB_LABEL:-$(basename "${BASH_SOURCE[1]:-$0}" .sh)}"

_log() { printf "\033[1;34m[%s]\033[0m %s\n" "$SYNC_LIB_LABEL" "$*"; }
_die() { printf "\033[1;31m[%s]\033[0m %s\n" "$SYNC_LIB_LABEL" "$*" >&2; exit 1; }

# Parse `-t/--target <name>` (and TARGET env var) out of the script args.
# Leftover args are written back to the SYNC_REST array.
#
# Sets: TARGET (string), SYNC_REST (array of unconsumed args).
sync_parse_target() {
  TARGET="${TARGET:-}"
  SYNC_REST=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t|--target) TARGET="$2"; shift 2 ;;
      *) SYNC_REST+=("$1"); shift ;;
    esac
  done
}

# Read catalog/schema/profile from `databricks bundle summary` for the
# active target and build the UC volume path for VOLUME_NAME.
#
# Sets: TARGET_NAME, PROFILE, CATALOG, SCHEMA, VOLUME_PATH,
#       SYNC_PROFILE_FLAG (array - empty when no profile is configured).
sync_resolve_volume() {
  local volume_name="$1"
  [[ -n "$volume_name" ]] || _die "sync_resolve_volume: volume name required"

  local summary
  if [[ -n "${TARGET:-}" ]]; then
    summary="$(databricks bundle summary -t "$TARGET" --output json)"
  else
    summary="$(databricks bundle summary --output json)"
  fi

  # Pull all four fields in one Python invocation; cheaper than four shellouts
  # and keeps the JSON parsing in one place.
  local extracted
  extracted="$(printf '%s' "$summary" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("bundle", {}).get("target", "?"))
print(d.get("workspace", {}).get("profile", ""))
print(d.get("variables", {}).get("catalog", {}).get("value", ""))
print(d.get("variables", {}).get("schema", {}).get("value", ""))
')"
  { read -r TARGET_NAME; read -r PROFILE; read -r CATALOG; read -r SCHEMA; } <<<"$extracted"

  [[ -n "$CATALOG" && -n "$SCHEMA" ]] || \
    _die "could not resolve catalog/schema from bundle summary (target=$TARGET_NAME)"

  VOLUME_PATH="/Volumes/${CATALOG}/${SCHEMA}/${volume_name}"

  # Pass --profile only when bundle summary actually returned one; the CLI
  # rejects --profile ''. Use an array so `set -u` doesn't blow up on the
  # empty case.
  if [[ -n "$PROFILE" ]]; then
    SYNC_PROFILE_FLAG=(--profile "$PROFILE")
  else
    SYNC_PROFILE_FLAG=()
  fi
}

# Run `databricks sync` from SRC_DIR to DST_VOLUME_PATH. Extra args after
# the first two are forwarded to `databricks sync` (e.g. --exclude foo).
#
# `databricks sync` is incremental by default - unchanged files are not
# re-uploaded, which is the whole reason these scripts call into it.
#
# After the sync, run a verification pass: list remote sizes and diff
# against local, then re-upload any size mismatches via `databricks fs cp
# --overwrite`. This catches `databricks sync`'s known bug where it
# records a file as synced in the snapshot before the upload actually
# completes - once in the snapshot, subsequent incremental runs skip the
# file forever (until local mtime changes). The repair pass costs one
# extra `fs ls` round trip per call but is essential for correctness.
sync_run() {
  local src="$1"; shift
  local dst="$1"; shift

  [[ -d "$src" ]] || _die "missing source dir: $src"

  _log "target=${TARGET_NAME:-?} profile=${PROFILE:-<default>} -> dbfs:$dst"

  # `databricks sync` would be the obvious choice (incremental, watches
  # for changes), but it currently fails with "does not have View
  # permissions on 0" against managed UC volumes on workspaces with
  # Default Storage enabled, even when the operator owns the volume.
  # `databricks fs cp --overwrite -r` works on the same volume from the
  # same identity, so we use that for the initial push and let
  # sync_repair below skip anything that's already correctly sized.
  #
  # First call after a clean deploy uploads everything; subsequent
  # re-syncs are fast because sync_repair size-checks each file and only
  # re-uploads on mismatch.
  databricks fs cp ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} \
    --overwrite --recursive "$src" "dbfs:${dst}"

  sync_repair "$src" "$dst"
}

# Verify every file in SRC_DIR matches its remote size at DST_VOLUME_PATH,
# re-uploading any that don't. Called automatically by `sync_run`; safe
# to call directly if you ever want to re-verify without doing a full
# sync. Skips dotfiles + the .databricks state dir.
sync_repair() {
  local src="$1"; shift
  local dst="$1"; shift

  local remote
  if ! remote="$(databricks fs ls ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} --long "dbfs:${dst}" 2>/dev/null)"; then
    _log "verify: skipped (could not list ${dst})"
    return 0
  fi

  local repaired=0 checked=0 missing=0
  local entry name local_size remote_size
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    [[ "$name" == .* ]] && continue
    checked=$((checked + 1))
    local_size="$(stat -f%z "$entry" 2>/dev/null || stat -c%s "$entry")"
    remote_size="$(printf '%s\n' "$remote" | awk -v f="$name" '$NF == f {print $2; exit}')"
    if [[ -z "$remote_size" ]]; then
      _log "verify: re-uploading $name (missing on volume, local=${local_size})"
      missing=$((missing + 1))
      databricks fs cp ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} --overwrite "$entry" "dbfs:${dst}/${name}" >/dev/null
      repaired=$((repaired + 1))
    elif [[ "$local_size" != "$remote_size" ]]; then
      _log "verify: re-uploading $name (size mismatch local=${local_size} remote=${remote_size})"
      databricks fs cp ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} --overwrite "$entry" "dbfs:${dst}/${name}" >/dev/null
      repaired=$((repaired + 1))
    fi
  done < <(find "$src" -maxdepth 1 -type f -print0)

  if (( repaired > 0 )); then
    _log "verify: ${checked} checked, ${repaired} repaired (${missing} missing)."
  else
    _log "verify: ${checked} checked, all in sync."
  fi
}
