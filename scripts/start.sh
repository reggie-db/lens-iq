#!/usr/bin/env bash
# Databricks Apps boot wrapper for lens-iq.
#
# Wraps the normal `node build/index.mjs` entrypoint with a portr client so
# the app is reachable at https://lensiq.apps.dbx.tools without going through
# the workspace SSO redirect. The tunnel client lives entirely inside the
# app container; the workspace itself is unmodified.
#
# Boot sequence:
#   1. Re-root HOME under cwd so the portr installer and config land in a
#      writable, per-app location (the platform $HOME is read-only in
#      practice on cold start).
#   2. Install portr from https://install.portr.dev (idempotent across
#      restarts since the installer skips when the on-PATH binary is
#      already the latest release).
#   3. Render ~/.portr/config.yaml using APPS_DBX_TOOLS_TOKEN (sourced from a
#      Databricks secret via app.yaml -> resources/app.yml) and the app's
#      DATABRICKS_APP_PORT.
#   4. Background BOTH `portr start` and the node entrypoint so this shell
#      stays alive as the supervisor. Without that supervisor role the
#      previous `exec node ...` setup orphaned the backgrounded portr
#      process when the Apps platform sent SIGTERM at container teardown.
#
# Shutdown sequence (SIGTERM / SIGINT / SIGHUP):
#   1. Forward SIGTERM to both portr and node.
#   2. Wait up to SHUTDOWN_GRACE_SECS (10s) for them to exit cleanly.
#   3. SIGKILL anything still alive past the grace window.
set -euo pipefail

export HOME="${PWD}/.home"
mkdir -p "${HOME}/.portr/bin"

export PORTR_AUTO_ADD_PATH=no
export PATH="${HOME}/.portr/bin:${PATH}"

curl -sSf https://install.portr.dev | sh

cat > "${HOME}/.portr/config.yaml" <<EOF
server_url: apps.dbx.tools
ssh_url: apps.dbx.tools:4444
secret_key: ${APPS_DBX_TOOLS_TOKEN}
disable_dashboard: true
disable_tui: true
tunnels:
  - name: lensiq
    subdomain: lensiq
    port: ${DATABRICKS_APP_PORT}
EOF

# ─── Graceful shutdown ──────────────────────────────────────────────────
# How long to wait for children to exit on their own after SIGTERM before
# escalating to SIGKILL.
readonly SHUTDOWN_GRACE_SECS=10

_portr_pid=""
_node_pid=""
_shutdown=0

# Send SIGTERM to both children, then background a SIGKILL escalator so the
# main script can keep wait-ing on its children in parallel with the grace
# countdown.
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

portr start &
_portr_pid=$!

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
