#!/usr/bin/env bash
# Databricks Apps boot wrapper for lensiq.
#
# Always supervises the node entrypoint. Optionally publishes the app to a
# public URL through portr (https://portr.dev) when PUBLIC_DOMAIN is set.
#
# Public tunnel (opt-in):
#   To turn the tunnel on, set both env vars in app.yaml:
#     PUBLIC_DOMAIN=<subdomain>.<server_host>   e.g. lensiq.apps.dbx.tools
#     PORTR_TOKEN=<portr secret_key>            usually `valueFrom:` a secret
#   The leftmost dotted label of PUBLIC_DOMAIN becomes the portr subdomain
#   (and tunnel name), and everything to the right of the first dot becomes
#   the portr server host. So `lensiq.apps.dbx.tools` registers subdomain
#   `lensiq` against the portr server at `apps.dbx.tools`.
#
#   When PUBLIC_DOMAIN is unset (or PORTR_TOKEN is empty), this script
#   skips the portr install + tunnel completely - it just runs node.
#
# When the tunnel is enabled, boot sequence is:
#   1. Re-root HOME under cwd so the portr installer and config land in a
#      writable, per-app location (the platform $HOME is read-only in
#      practice on cold start).
#   2. Install portr from https://install.portr.dev (idempotent across
#      restarts since the installer skips when the on-PATH binary is
#      already the latest release).
#   3. Render ~/.portr/config.yaml from PUBLIC_DOMAIN + PORTR_TOKEN and the
#      app's DATABRICKS_APP_PORT.
#   4. Background `portr start` alongside the node entrypoint so this shell
#      stays alive as the supervisor.
#
# Shutdown sequence (SIGTERM / SIGINT / SIGHUP):
#   1. Forward SIGTERM to both portr (if started) and node.
#   2. Wait up to SHUTDOWN_GRACE_SECS (10s) for them to exit cleanly.
#   3. SIGKILL anything still alive past the grace window.
set -euo pipefail

readonly SHUTDOWN_GRACE_SECS=10

_portr_pid=""
_node_pid=""
_shutdown=0

# Optional public tunnel: only fire when the operator has explicitly set
# PUBLIC_DOMAIN. Empty or unset = no install, no tunnel.
if [[ -n "${PUBLIC_DOMAIN:-}" ]]; then
  if [[ -z "${PORTR_TOKEN:-}" ]]; then
    echo "[start] PUBLIC_DOMAIN=${PUBLIC_DOMAIN} set but PORTR_TOKEN is empty - skipping public tunnel" >&2
  else
    _portr_subdomain="${PUBLIC_DOMAIN%%.*}"
    _portr_server="${PUBLIC_DOMAIN#*.}"
    if [[ "$_portr_subdomain" == "$PUBLIC_DOMAIN" || -z "$_portr_server" ]]; then
      echo "[start] PUBLIC_DOMAIN=${PUBLIC_DOMAIN} must include a subdomain (e.g. lensiq.apps.dbx.tools) - skipping public tunnel" >&2
    else
      export HOME="${PWD}/.home"
      mkdir -p "${HOME}/.portr/bin"

      export PORTR_AUTO_ADD_PATH=no
      export PATH="${HOME}/.portr/bin:${PATH}"

      curl -sSf https://install.portr.dev | sh

      cat > "${HOME}/.portr/config.yaml" <<EOF
server_url: ${_portr_server}
ssh_url: ${_portr_server}:4444
secret_key: ${PORTR_TOKEN}
disable_dashboard: true
disable_tui: true
tunnels:
  - name: ${_portr_subdomain}
    subdomain: ${_portr_subdomain}
    port: ${DATABRICKS_APP_PORT}
EOF

      portr start &
      _portr_pid=$!
      echo "[start] portr tunneling https://${PUBLIC_DOMAIN} -> :${DATABRICKS_APP_PORT} (pid=${_portr_pid})" >&2
    fi
  fi
fi

# ─── Graceful shutdown ──────────────────────────────────────────────────
# Send SIGTERM to both children (no-op if portr never started), then
# background a SIGKILL escalator so the main script can keep wait-ing on
# its children in parallel with the grace countdown.
_signal_handler() {
  local sig=$1
  if (( _shutdown )); then return; fi
  _shutdown=1
  echo "[start] caught ${sig}, forwarding SIGTERM to portr=${_portr_pid:-} app=${_node_pid:-}" >&2
  if [[ -n "$_portr_pid" ]]; then kill -TERM "$_portr_pid" 2>/dev/null || true; fi
  if [[ -n "$_node_pid"  ]]; then kill -TERM "$_node_pid"  2>/dev/null || true; fi

  (
    sleep "$SHUTDOWN_GRACE_SECS"
    for pid in "$_portr_pid" "$_node_pid"; do
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
if [[ -n "$_portr_pid" ]] && kill -0 "$_portr_pid" 2>/dev/null; then
  kill -TERM "$_portr_pid" 2>/dev/null || true
  for _ in $(seq 1 "$SHUTDOWN_GRACE_SECS"); do
    kill -0 "$_portr_pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "$_portr_pid" 2>/dev/null || true
  wait "$_portr_pid" 2>/dev/null || true
fi

exit "$_exit_code"
