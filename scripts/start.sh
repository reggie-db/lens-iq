#!/usr/bin/env bash
# Databricks Apps boot wrapper for lensiq.
#
# Always supervises the node entrypoint. Optionally publishes the app to a
# public URL through an frp client (https://github.com/fatedier/frp) when
# AZURE_CONTAINER_APPS is set.
#
# Public tunnel (opt-in):
#   To turn the tunnel on, set in app.yaml:
#     AZURE_CONTAINER_APPS=<fqdn>    e.g. lensiq.<region>.azurecontainerapps.io
#     TUNNEL_TOKEN=<frp auth token>  OPTIONAL - usually `valueFrom:` a secret
#
#   AZURE_CONTAINER_APPS is the native Azure Container Apps FQDN that fronts
#   the self-hosted frps server: the platform terminates TLS on :443 with its
#   managed cert and forwards to frps. The same FQDN is used as BOTH the frpc
#   serverAddr and the vhost customDomain, so the one URL carries the client
#   control connection (frp `wss` transport - TLS handshake before the
#   websocket handshake, which the TLS-terminating ingress requires) AND
#   serves public visitor traffic (frps port-reuse). The leftmost dotted
#   label becomes the frpc proxy name (e.g. `lensiq`).
#
#   TUNNEL_TOKEN is optional: when set it is sent as the frp auth token (the
#   frps server must be configured with the same token); when empty the
#   tunnel still comes up with no auth.
#
#   When AZURE_CONTAINER_APPS is unset, this script skips the frp install +
#   tunnel completely - it just runs node.
#
# When the tunnel is enabled, boot sequence is:
#   1. Re-root HOME under cwd so the frp binary and config land in a
#      writable, per-app location (the platform $HOME is read-only in
#      practice on cold start).
#   2. Download frpc from the pinned GitHub release into $HOME/.frp/bin
#      (idempotent across restarts - skips when the on-disk binary already
#      matches FRP_VERSION).
#   3. Render $HOME/.frp/frpc.toml from AZURE_CONTAINER_APPS + TUNNEL_TOKEN
#      and the app's DATABRICKS_APP_PORT.
#   4. Background `frpc` alongside the node entrypoint so this shell stays
#      alive as the supervisor.
#
# Shutdown sequence (SIGTERM / SIGINT / SIGHUP):
#   1. Forward SIGTERM to both frpc (if started) and node.
#   2. Wait up to SHUTDOWN_GRACE_SECS (10s) for them to exit cleanly.
#   3. SIGKILL anything still alive past the grace window.
set -euo pipefail

readonly SHUTDOWN_GRACE_SECS=10
readonly FRP_VERSION="${FRP_VERSION:-0.68.1}"

_frp_pid=""
_node_pid=""
_shutdown=0

# Optional public tunnel: only fire when the operator has explicitly set
# AZURE_CONTAINER_APPS. Empty or unset = no install, no tunnel.
if [[ -n "${AZURE_CONTAINER_APPS:-}" ]]; then
  # Accept a bare host or a full URL; normalize to the bare FQDN.
  _frp_host="${AZURE_CONTAINER_APPS#http://}"
  _frp_host="${_frp_host#https://}"
  _frp_host="${_frp_host%%/*}"
  _frp_name="${_frp_host%%.*}"

  export HOME="${PWD}/.home"
  _frp_bin="${HOME}/.frp/bin/frpc"
  mkdir -p "${HOME}/.frp/bin"
  export PATH="${HOME}/.frp/bin:${PATH}"

  # Idempotent install: download + extract frpc only when the on-disk binary
  # is missing or a different release than FRP_VERSION (frpc --version prints
  # the bare version string, e.g. `0.68.1`).
  if [[ ! -x "$_frp_bin" ]] || ! "$_frp_bin" --version 2>/dev/null | grep -qx "$FRP_VERSION"; then
    _frp_pkg="frp_${FRP_VERSION}_linux_amd64"
    _frp_tmp="$(mktemp -d)"
    curl -sSfL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${_frp_pkg}.tar.gz" \
      | tar -xz -C "$_frp_tmp"
    install -m 0755 "${_frp_tmp}/${_frp_pkg}/frpc" "$_frp_bin"
    rm -rf "$_frp_tmp"
  fi

  # frpc dials the native Azure FQDN on :443 using frp's `wss` transport: the
  # Container Apps ingress terminates TLS with the platform-managed cert for
  # the default domain, then forwards the (now plaintext) websocket upgrade to
  # frps. `wss` runs the TLS handshake BEFORE the websocket handshake, which is
  # what a TLS-terminating L7 proxy requires - plain `websocket` reverses that
  # order and fails. The http proxy's customDomains is that same FQDN, so frps
  # routes all visitor traffic for the host down this tunnel to the local app.
  # TUNNEL_TOKEN is appended only when set (auth is optional).
  {
    cat <<EOF
serverAddr = "${_frp_host}"
serverPort = 443
transport.protocol = "wss"
EOF
    if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
      printf 'auth.token = "%s"\n' "${TUNNEL_TOKEN}"
    fi
    cat <<EOF

[[proxies]]
name = "${_frp_name}"
type = "http"
localPort = ${DATABRICKS_APP_PORT}
customDomains = ["${_frp_host}"]
EOF
  } > "${HOME}/.frp/frpc.toml"

  frpc -c "${HOME}/.frp/frpc.toml" &
  _frp_pid=$!
  echo "[start] frpc tunneling https://${_frp_host} -> :${DATABRICKS_APP_PORT} (pid=${_frp_pid})" >&2
fi

# ─── Graceful shutdown ──────────────────────────────────────────────────
# Send SIGTERM to both children (no-op if frpc never started), then
# background a SIGKILL escalator so the main script can keep wait-ing on
# its children in parallel with the grace countdown.
_signal_handler() {
  local sig=$1
  if (( _shutdown )); then return; fi
  _shutdown=1
  echo "[start] caught ${sig}, forwarding SIGTERM to frpc=${_frp_pid:-} app=${_node_pid:-}" >&2
  if [[ -n "$_frp_pid" ]]; then kill -TERM "$_frp_pid" 2>/dev/null || true; fi
  if [[ -n "$_node_pid" ]]; then kill -TERM "$_node_pid" 2>/dev/null || true; fi

  (
    sleep "$SHUTDOWN_GRACE_SECS"
    for pid in "$_frp_pid" "$_node_pid"; do
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

# If frpc is still up (node usually exits first because the trap fans the
# signal to both children but node responds faster), give it the same grace
# path so we don't leave a zombie behind when the supervisor returns.
if [[ -n "$_frp_pid" ]] && kill -0 "$_frp_pid" 2>/dev/null; then
  kill -TERM "$_frp_pid" 2>/dev/null || true
  for _ in $(seq 1 "$SHUTDOWN_GRACE_SECS"); do
    kill -0 "$_frp_pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "$_frp_pid" 2>/dev/null || true
  wait "$_frp_pid" 2>/dev/null || true
fi

exit "$_exit_code"
