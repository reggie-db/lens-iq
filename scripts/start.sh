#!/usr/bin/env bash
# Databricks Apps boot wrapper for lensiq.
#
# Supervises the node entrypoint and forwards SIGTERM / SIGINT / SIGHUP so
# the Apps platform can drain the process cleanly. There is no public tunnel
# / frpc path - the app is reachable only via the Databricks Apps URL.
set -euo pipefail

readonly SHUTDOWN_GRACE_SECS=10

_node_pid=""

_shutdown() {
  local sig="$1"
  echo "[start] caught ${sig}, forwarding SIGTERM to app=${_node_pid:-}" >&2
  if [[ -n "$_node_pid" ]]; then kill -TERM "$_node_pid" 2>/dev/null || true; fi
  local deadline=$((SECONDS + SHUTDOWN_GRACE_SECS))
  while (( SECONDS < deadline )); do
    if [[ -n "$_node_pid" ]] && kill -0 "$_node_pid" 2>/dev/null; then
      sleep 0.2
      continue
    fi
    break
  done
  if [[ -n "$_node_pid" ]] && kill -0 "$_node_pid" 2>/dev/null; then
    kill -KILL "$_node_pid" 2>/dev/null || true
  fi
}

trap '_shutdown TERM; exit 143' TERM
trap '_shutdown INT;  exit 130' INT
trap '_shutdown HUP;  exit 129' HUP

node build/index.mjs &
_node_pid=$!
wait "$_node_pid"
_exit=$?

if [[ -n "$_node_pid" ]] && kill -0 "$_node_pid" 2>/dev/null; then
  kill -TERM "$_node_pid" 2>/dev/null || true
  sleep 0.5
  kill -KILL "$_node_pid" 2>/dev/null || true
  wait "$_node_pid" 2>/dev/null || true
fi

exit "$_exit"
