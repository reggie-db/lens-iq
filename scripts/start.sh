#!/usr/bin/env bash
# Databricks Apps boot wrapper for lensiq.
#
# Always supervises the node entrypoint. Optionally publishes the app to a
# stable public URL through a portr client (https://github.com/amalshaji/portr)
# when TUNNEL_SUBDOMAIN is set.
#
# Public tunnel (opt-in):
#   To turn the tunnel on, set in app.yaml:
#     TUNNEL_SUBDOMAIN=<subdomain>   e.g. lensiq  -> https://lensiq.<server>
#     TUNNEL_SERVER=<host>           e.g. apps.dbx.tools (portr server_url)
#     TUNNEL_TOKEN=<portr secret>    REQUIRED - the portr cli auth token,
#                                    usually `valueFrom:` a secret
#     TUNNEL_SSH=<host:port>         OPTIONAL - portr ssh_url; defaults to
#                                    "${TUNNEL_SERVER}:4444"
#
#   portr dials the portr server over SSH (ssh_url, default :4444) and exposes
#   the local app under https://<TUNNEL_SUBDOMAIN>.<TUNNEL_SERVER>. The subdomain
#   must be reserved for the account that owns TUNNEL_TOKEN on the portr server.
#
#   When TUNNEL_SUBDOMAIN is unset, this script skips the portr install +
#   tunnel completely - it just runs node.
#
# When the tunnel is enabled, boot sequence is:
#   1. Re-root HOME under cwd so the portr binary and config land in a
#      writable, per-app location (the platform $HOME is read-only in
#      practice on cold start).
#   2. Download the portr client from the pinned GitHub release into
#      $HOME/.portr/bin (idempotent across restarts - skips when the on-disk
#      binary already matches PORTR_VERSION).
#   3. Render $HOME/.portr/config.yaml from TUNNEL_SERVER + TUNNEL_TOKEN.
#   4. Background `portr http <DATABRICKS_APP_PORT> -s <TUNNEL_SUBDOMAIN>`
#      alongside the node entrypoint so this shell stays alive as supervisor.
#
# Shutdown sequence (SIGTERM / SIGINT / SIGHUP):
#   1. Forward SIGTERM to both portr (if started) and node.
#   2. Wait up to SHUTDOWN_GRACE_SECS (10s) for them to exit cleanly.
#   3. SIGKILL anything still alive past the grace window.
set -euo pipefail

readonly SHUTDOWN_GRACE_SECS=10
readonly PORTR_VERSION="${PORTR_VERSION:-1.0.13}"

_tunnel_pid=""
_node_pid=""
_shutdown=0

# Optional public tunnel: only fire when the operator has explicitly set
# TUNNEL_SUBDOMAIN. Empty or unset = no install, no tunnel.
if [[ -n "${TUNNEL_SUBDOMAIN:-}" ]]; then
  _tunnel_server="${TUNNEL_SERVER:-apps.dbx.tools}"
  _tunnel_ssh="${TUNNEL_SSH:-${_tunnel_server}:4444}"

  export HOME="${PWD}/.home"
  _portr_bin="${HOME}/.portr/bin/portr"
  mkdir -p "${HOME}/.portr/bin"
  export PATH="${HOME}/.portr/bin:${PATH}"

  # Idempotent install: download + extract the portr client only when the
  # on-disk binary is missing or a different release than PORTR_VERSION
  # (portr --version prints e.g. `portr version 1.0.13`). The release ships a
  # zip whose archive root holds a single `portr` executable.
  if [[ ! -x "$_portr_bin" ]] || ! "$_portr_bin" --version 2>/dev/null | grep -q "$PORTR_VERSION"; then
    case "$(uname -m)" in
      x86_64|amd64)  _portr_arch="x86_64" ;;
      aarch64|arm64) _portr_arch="arm64" ;;
      *)             _portr_arch="x86_64" ;;
    esac
    _portr_pkg="portr_${PORTR_VERSION}_Linux_${_portr_arch}"
    _portr_tmp="$(mktemp -d)"
    curl -sSfL "https://github.com/amalshaji/portr/releases/download/v${PORTR_VERSION}/${_portr_pkg}.zip" \
      -o "${_portr_tmp}/portr.zip"
    # Extract the zip. Prefer unzip; fall back to python3's zipfile when the
    # base image ships no unzip (common on slim runtimes).
    if command -v unzip >/dev/null 2>&1; then
      unzip -o -q "${_portr_tmp}/portr.zip" -d "${_portr_tmp}"
    else
      python3 -m zipfile -e "${_portr_tmp}/portr.zip" "${_portr_tmp}"
    fi
    install -m 0755 "${_portr_tmp}/portr" "$_portr_bin"
    rm -rf "$_portr_tmp"
  fi

  # portr reads server_url / ssh_url / secret_key from this config for auth.
  # secret_key (TUNNEL_TOKEN) is required: without it the cli handshake fails
  # with "Invalid secret key" and the tunnel never comes up. The dashboard +
  # TUI are disabled because there is no interactive terminal in the Apps
  # runtime.
  #
  # The requested subdomain MUST be pinned through a `tunnels:` block and
  # started with `portr start <name>`. The flag form (`portr http <port> -s
  # <sub>`) silently ignores the subdomain and the server hands back a random
  # one instead, so it is not used here.
  mkdir -p "${HOME}/.portr"
  {
    printf 'server_url: %s\n' "${_tunnel_server}"
    printf 'ssh_url: %s\n' "${_tunnel_ssh}"
    if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
      printf 'secret_key: %s\n' "${TUNNEL_TOKEN}"
    fi
    printf 'disable_dashboard: true\n'
    printf 'disable_tui: true\n'
    printf 'tunnels:\n'
    printf '  - name: %s\n' "${TUNNEL_SUBDOMAIN}"
    printf '    subdomain: %s\n' "${TUNNEL_SUBDOMAIN}"
    printf '    port: %s\n' "${DATABRICKS_APP_PORT}"
  } > "${HOME}/.portr/config.yaml"

  portr start "${TUNNEL_SUBDOMAIN}" &
  _tunnel_pid=$!
  echo "[start] portr tunneling https://${TUNNEL_SUBDOMAIN}.${_tunnel_server} -> :${DATABRICKS_APP_PORT} (pid=${_tunnel_pid})" >&2
fi

# ─── Graceful shutdown ──────────────────────────────────────────────────
# Send SIGTERM to both children (no-op if portr never started), then
# background a SIGKILL escalator so the main script can keep wait-ing on
# its children in parallel with the grace countdown.
_signal_handler() {
  local sig=$1
  if (( _shutdown )); then return; fi
  _shutdown=1
  echo "[start] caught ${sig}, forwarding SIGTERM to portr=${_tunnel_pid:-} app=${_node_pid:-}" >&2
  if [[ -n "$_tunnel_pid" ]]; then kill -TERM "$_tunnel_pid" 2>/dev/null || true; fi
  if [[ -n "$_node_pid" ]]; then kill -TERM "$_node_pid" 2>/dev/null || true; fi

  (
    sleep "$SHUTDOWN_GRACE_SECS"
    for pid in "$_tunnel_pid" "$_node_pid"; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "[start] pid $pid still alive after ${SHUTDOWN_GRACE_SECS}s, sending SIGKILL" >&2
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
  ) &
}

trap '_signal_handler TERM' TERM
trap '_signal_handler INT'  INT
trap '_signal_handler HUP'  HUP

node build/index.mjs &
_node_pid=$!

# Node is the foreground role the Apps platform health-checks against, so
# the script's exit code mirrors the node process. `wait` returns 128+N when
# interrupted by a trapped signal without reaping the child, so loop until
# the child is actually gone to capture the real exit code.
_exit_code=0
while kill -0 "$_node_pid" 2>/dev/null; do
  if wait "$_node_pid" 2>/dev/null; then
    _exit_code=0
  else
    _exit_code=$?
  fi
done

# If portr is still up (node usually exits first because the trap fans the
# signal to both children but node responds faster), give it the same grace
# path so we don't leave a zombie behind when the supervisor returns.
if [[ -n "$_tunnel_pid" ]] && kill -0 "$_tunnel_pid" 2>/dev/null; then
  kill -TERM "$_tunnel_pid" 2>/dev/null || true
  for _ in $(seq 1 "$SHUTDOWN_GRACE_SECS"); do
    kill -0 "$_tunnel_pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "$_tunnel_pid" 2>/dev/null || true
  wait "$_tunnel_pid" 2>/dev/null || true
fi

exit "$_exit_code"
