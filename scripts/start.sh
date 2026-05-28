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
#   4. Background `portr start` so the foreground process the Apps platform
#      health-checks is the actual node server, then exec into it.
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

portr start &

exec node build/index.mjs
