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

# Echo the `databricks fs ls --long` listing for a volume path. Prints the
# raw listing on success (may be empty for an existing-but-empty volume) and
# returns non-zero when the path can't be listed at all (e.g. the volume
# doesn't exist yet). Centralized so sync_run and sync_repair share one
# listing format + profile-flag handling.
sync_remote_list() {
  local dst="$1"
  databricks fs ls ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} --long "dbfs:${dst}" 2>/dev/null
}

# Mirror SRC_DIR into DST_VOLUME_PATH, uploading the least amount possible.
#
# Strategy: inspect what's already on the volume BEFORE uploading anything.
#   - Volume unlistable or empty -> seed it with a single recursive
#     `fs cp --overwrite -r` (one shot is faster than N per-file copies on a
#     cold volume).
#   - Volume already populated -> skip the blanket overwrite entirely and let
#     sync_repair do a per-file metadata (size) diff, uploading only the files
#     that are missing or whose size differs from local. This is what keeps a
#     redeploy from re-pushing hundreds of MB of unchanged MP4s.
#
# `databricks sync` would be the obvious choice (incremental, watches for
# changes), but it currently fails with "does not have View permissions on 0"
# against managed UC volumes on workspaces with Default Storage enabled, even
# when the operator owns the volume. `databricks fs cp` works on the same
# volume from the same identity, so the seed + per-file repair below stand in
# for it.
sync_run() {
  local src="$1"; shift
  local dst="$1"; shift

  [[ -d "$src" ]] || _die "missing source dir: $src"

  _log "target=${TARGET_NAME:-?} profile=${PROFILE:-<default>} -> dbfs:$dst"

  # List the volume once up front. Count only real files (skip dotfiles) so an
  # empty-but-existing volume is treated the same as a brand-new one.
  local remote remote_files
  remote="$(sync_remote_list "$dst" || true)"
  remote_files="$(printf '%s\n' "$remote" | awk 'NF && $NF !~ /^\./ {c++} END{print c+0}')"

  if [[ -z "$remote" || "$remote_files" -eq 0 ]]; then
    _log "remote empty - seeding volume with one recursive upload"
    databricks fs cp ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} \
      --overwrite --recursive "$src" "dbfs:${dst}"
    remote="$(sync_remote_list "$dst" || true)"
  else
    _log "remote has ${remote_files} file(s) - comparing metadata, uploading only changes"
  fi

  sync_repair "$src" "$dst" "$remote"
}

# Verify every file in SRC_DIR matches its remote size at DST_VOLUME_PATH,
# re-uploading any that don't. Called automatically by `sync_run`; safe
# to call directly if you ever want to re-verify without doing a full
# sync. Skips dotfiles + the .databricks state dir.
#
# An optional third argument is a pre-fetched `fs ls --long` listing (as
# produced by sync_remote_list). sync_run passes the listing it already
# fetched so the volume is listed once per sync rather than twice; called
# without it, this fetches its own listing.
sync_repair() {
  local src="$1"; shift
  local dst="$1"; shift
  local remote="${1:-}"

  if [[ -z "$remote" ]]; then
    if ! remote="$(sync_remote_list "$dst")"; then
      _log "verify: skipped (could not list ${dst})"
      return 0
    fi
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
