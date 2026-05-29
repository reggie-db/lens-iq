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
sync_run() {
  local src="$1"; shift
  local dst="$1"; shift

  [[ -d "$src" ]] || _die "missing source dir: $src"

  _log "target=${TARGET_NAME:-?} profile=${PROFILE:-<default>} -> dbfs:$dst"
  databricks sync ${SYNC_PROFILE_FLAG[@]+"${SYNC_PROFILE_FLAG[@]}"} "$@" "$src" "$dst"
}
