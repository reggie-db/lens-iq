# Deploy LensIQ to your own workspace

End-to-end steps to stand up LensIQ (the computer-vision demo app) in a fresh
Databricks workspace. This is the practical, "what actually works today"
companion to the architectural notes in `README.md`.

> **Heads up - this is a little rough.** The bundle is configured for the
> `direct` deploy engine, but existing workspaces that were first deployed with
> an older CLI carry `terraform` state, and the terraform path trips over a
> couple of Databricks API limitations (see
> [Known rough edges](#known-rough-edges)). The workarounds below are reliable;
> they just aren't a single clean `deploy.sh` run on every workspace. On a
> truly fresh workspace (no prior LensIQ deploy) `scripts/deploy.sh` usually
> runs clean end-to-end.

---

## 1. Prerequisites

- **Databricks CLI** authenticated to your target workspace:

  ```bash
  databricks auth login --profile <YOUR_PROFILE>
  databricks auth describe -p <YOUR_PROFILE>     # sanity check
  ```

- On your PATH: `node` (+ `npm`), `jq`, `psql`. `bun` is used locally (this repo
  pins `bun.lock`); the Databricks Apps build runs `npm ci` / `npm run build`,
  so keep `package.json` npm-compatible.
- A **SQL warehouse** in the workspace (serverless is fine), and a **Unity
  Catalog catalog + schema** you can write to (or let the bundle create the
  schema under an existing catalog).
- A **Claude serving endpoint** (e.g. `databricks-claude-opus-4-...`) or
  override `llm_endpoint` at deploy time.
- Optional: a **Roboflow API key** (license-plate + slip/fall detectors).

---

## 2. Point the repo at your workspace

All workspace-specific values live in `.env` (sourced by `scripts/deploy.sh`)
and a few literal files that DABs can't interpolate.

1. Edit `.env`:

   ```bash
   DATABRICKS_CONFIG_PROFILE=<YOUR_PROFILE>
   DATABRICKS_WAREHOUSE_ID=<warehouse_id>
   BUNDLE_VAR_warehouse_id=<warehouse_id>

   DATABRICKS_CATALOG=<your_catalog>
   BUNDLE_VAR_catalog=<your_catalog>
   DATABRICKS_SCHEMA=lens_iq
   ```

2. Rewrite the catalog/schema everywhere else (app.yaml literals, notebooks,
   Genie JSON, pipeline conf) in one pass:

   ```bash
   scripts/swap-uc.sh --catalog <your_catalog> --schema lens_iq
   ```

   It reads the current defaults out of `databricks.yml`, rewrites the YAML
   defaults + static file artifacts, and prints the redeploy command. It does
   **not** rename bundle resource IDs or serving-endpoint names - those are
   independent identifiers.

3. (Optional) secret values, read from env by `scripts/deploy.sh`:

   ```bash
   export ROBOFLOW_API_KEY=<roboflow-key>
   export SMTP_PASSWORD=<smtp-password>   # only if using send_email
   ```

---

## 3. The happy path (fresh workspace)

```bash
scripts/deploy.sh -t dev
```

`deploy.sh` is idempotent and runs 9 phases: bundle deploy
(schema/volumes/secret-scope/lakebase/jobs/pipeline + app) -> secrets ->
volume sync -> Lakebase grants -> Genie space -> UC/Genie/serving grants
(`scripts/grant-app-access.sh`) -> per-detector model deploys ->
`bundle run` -> app start. First run is ~10-15 min (cold-start endpoints warm
in parallel); later runs are 30-60 s.

If that completes without errors, you're done - skip to
[Verify](#5-verify). If the bundle step errors with `terraform apply` /
`failed to update app` / `project slug already exists`, use the manual path
below.

---

## 4. The manual path (existing workspace / terraform state)

When `scripts/deploy.sh` dies in phase 1 on the terraform errors, the bundle
**file upload still succeeds** before the resource apply fails - so the app
source is already staged in the workspace. Deliver the remaining pieces
directly. Replace `<you@example.com>` with your workspace user (the bundle
files path is `/Workspace/Users/<you>/.bundle/lens-iq/dev/files`).

```bash
# Make the CLI profile + bundle vars visible to this shell.
set -a; source .env; set +a
APP=lens-iq
SRC=/Workspace/Users/<you@example.com>/.bundle/lens-iq/dev/files

# 4a. Push secrets into the bundle-owned scope (lens-iq).
databricks secrets put-secret lens-iq roboflow_api_key --string-value "$ROBOFLOW_API_KEY" -p "$DATABRICKS_CONFIG_PROFILE" # only if using Roboflow
databricks secrets put-secret lens-iq smtp_password --string-value "$SMTP_PASSWORD" -p "$DATABRICKS_CONFIG_PROFILE" # only if using email

# 4b. Grant the app's service principal READ on the scope, or secret-backed
#     env vars (SMTP_PASSWORD, etc.) inject as empty strings.
SP=$(databricks apps get "$APP" -p "$DATABRICKS_CONFIG_PROFILE" --output json | jq -r '.service_principal_client_id')
databricks secrets put-acl lens-iq "$SP" READ -p "$DATABRICKS_CONFIG_PROFILE"

# 4c. Upload the latest source (ignore the terraform resource errors at the end -
#     the file upload happens first and is what we need).
databricks bundle deploy -t dev || true

# 4d. Deploy the app code (bypasses the terraform app-update API limitation).
databricks apps deploy "$APP" --source-code-path "$SRC" -p "$DATABRICKS_CONFIG_PROFILE"
```

Then run the rest of `deploy.sh`'s phases as needed (volume sync, Lakebase
grants, Genie, per-detector deploys):

```bash
scripts/deploy.sh -t dev --bundle-only   # no - this only re-runs phase 1
# Instead run the targeted helpers directly, e.g.:
scripts/sync-sample-videos.sh
scripts/sync-presenter-content.sh
scripts/grant-lakebase-schema.sh
```

---

## 5. Verify

```bash
PROFILE=<YOUR_PROFILE>

# App is running.
databricks apps get lens-iq -p "$PROFILE" --output json | jq -r '.app_status.message, .compute_status.state'

# Tail app logs (build + boot + plugin init).
databricks apps logs lens-iq -p "$PROFILE" | tail -40

# Open the app's standard URL:
databricks apps get lens-iq -p "$PROFILE" --output json | jq -r '.url'
```

---

## Known rough edges

| Symptom | Cause | What to do |
| --- | --- | --- |
| `Warning: Deployment engine "direct" ... does not match the existing state ("terraform")` | Workspace was first deployed with an older CLI that wrote terraform state. The CLI keeps using terraform. | Informational. The terraform path is what hits the two errors below. |
| `failed to update app ... Compute size updates are not supported in this update API` | The terraform provider uses the legacy app-update API, which rejects `compute_size` in the update mask. | Use the manual path (section 4): `databricks apps deploy` pushes code without going through that API. |
| `failed to create postgres_project ... project slug already exists` | The Lakebase project exists in the workspace but isn't tracked in terraform state (drift). | Left as drift; the app already uses the existing project. Don't recreate it. The manual path skips this. |
| `failed to get workspace client ... forced token refresh: ... exit status 45` | Transient OS-keyring race when the CLI refreshes the OAuth token under concurrent access. | Just retry the command. `databricks auth token -p <PROFILE>` confirms the token is actually fine. |
| Serving endpoint keep-alive appears inactive | `SERVING_ENDPOINT_KEEP_ALIVE=false`, no endpoint env vars are configured, or the current time is outside the configured business-hours window. | Check `.env` / `app.yaml` and `server/serving-keepalive.ts`. Keep-alive requests use the raw authenticated workspace client and intentionally swallow the model's empty-payload response. |

---

## Swapping workspaces later

`scripts/swap-uc.sh --catalog <new> --schema <new>` rewrites all three layers
(DABs vars, runtime app-code env, static file artifacts) at once and prints the
redeploy command. After running it, redo the workspace-side bootstrap (bundle
deploy + per-detector deploy jobs, or the manual path) before the app can find
its tables in the new home.
