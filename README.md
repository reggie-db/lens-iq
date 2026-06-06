# LensIQ

LensIQ is a computer-vision dashboard for QSR, gas-station, and
convenience-store operators. It's a single Databricks AppKit app: every
frame is a model invocation against a Databricks Model Serving endpoint
and every row lands in Unity Catalog or Lakebase Postgres. The booth
demo opens on a Fleet Operations Dashboard, then drills into one model
demo per use case (spills, plates, guests, faces, camera clarity,
slip & fall, PPE).

```
React UI (Vite)  ──►  AppKit plugins (analytics / serving / files / lakebase)
                              │
                              ├──►  SQL Warehouse           (analytics queries)
                              ├──►  Model Serving           (one endpoint per detector)
                              ├──►  Unity Catalog Volumes   (frames, sample videos, deck)
                              └──►  Lakebase Autoscaling    (faces pgvector, guest counts,
                                                             fog observations)
```

## What's in here

### Pages (`client/src/pages/`)

| Page                  | What it shows                                                                           |
| --------------------- | --------------------------------------------------------------------------------------- |
| Fleet Dashboard       | Landing view. Company-wide KPIs across 8 stores, one section per CV use case.           |
| Live Detection        | Webcam / sample-video stream into the YOLO detector.                                    |
| Guest Counts          | Pump → store conversion. Writes guest_counts into Lakebase.                             |
| License Plates        | YOLO finds the vehicle, Claude vision reads the plate. Joins to a synthetic POS feed.   |
| Spill Detection       | Claude vision on every frame, with time-to-cone documented per cycle.                   |
| Facial Recognition    | InsightFace SCRFD + ArcFace embeddings, matched with pgvector in Lakebase.              |
| Camera Clarity        | Pillow+numpy PyFunc fog detector. Auto-fires cleaning tickets.                          |
| Image Upload          | One-off upload against any detector endpoint.                                           |
| Pipeline              | Frame ingestion pipeline visualizer.                                                    |
| Detections            | Live SSE feed of the `detections` table + 24h aggregates.                               |
| Inventory             | Pizza stock + truck parking gauges (synthetic).                                         |
| Trends                | 7-day detection mix + hourly volume.                                                    |
| Alerts                | Operator alert stream with rule list.                                                   |
| All Devices           | IoT temperature monitoring grid (synthetic).                                            |
| Data Search           | Free-text detection-label search.                                                       |
| Talk Track            | Booth narrative, with LLM rewrite by speaker/audience persona and length.               |
| Booth Deck            | Standalone HTML deck mounted from the `presenter_content` volume.                       |

### Serving endpoints

Each detector has its own endpoint so cold-start, version history, and
workload size can be tuned independently. Endpoint names live in
`databricks.yml::variables.*_endpoint` and are surfaced to the app via
`DATABRICKS_SERVING_ENDPOINT_*` (see `app.yaml`).

| Endpoint                    | Backing model                                              |
| --------------------------- | ---------------------------------------------------------- |
| `databricks-claude-opus-4-7`| Foundation model. Powers chat, talk-track rewrite, spill / wet-floor-sign vision. |
| `lensiq-detector`           | YOLO general-objects PyFunc (Ultralytics).                 |
| `lensiq-license-plate`      | Roboflow license-plate model.                              |
| `lensiq-slip-fall`          | Roboflow slip-and-fall detector.                           |
| `lensiq-fog-detector`       | Pillow+numpy lens-condition classifier.                    |
| `lensiq-face-recognition`   | InsightFace buffalo_l + ArcFace 512-d embedder.            |

### AppKit plugins (`server/server.ts`)

| Plugin        | Purpose                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `server()`    | Express + Vite dev / static prod.                                           |
| `analytics()` | Parameterized SQL from `config/queries/*.sql`, run as the app SP.           |
| `serving()`   | One alias per endpoint above. Calls run on-behalf-of the logged-in user.    |
| `files()`     | UC volume mounts for `frames`, `frames_inbox`, `sample_videos`, `presenter_content`. |
| `lakebase()`  | OAuth-refreshed Postgres pool. Schema lives in `lensiq.*` on the bound DB.  |

### Custom routes

Wired up inline in `onPluginsReady` so the AppKit handle is fully typed.
Highlights:

| Route                                | Purpose                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST /api/detect`                   | Forwards a base64 image to the requested detector alias, normalizes the response.    |
| `POST /api/talk-track/transform`     | LLM rewrites the talk track by speaker/audience persona + length. Server-side LRU cache. |
| `GET  /api/detections/stream`        | SSE poller over the `detections` table.                                              |
| `GET  /api/face-matches/stream`      | SSE poller over the `face_matches` table.                                            |
| `GET  /api/presenter-content/:id`    | Streams talk track + booth deck from the `presenter_content` volume.                 |

### Unity Catalog layout

Catalog and schema are bundle variables (`catalog`, `schema` in
`databricks.yml`). Defaults are `retail_consumer_goods.lens_iq`. The
deployed app reads them at runtime from `DATABRICKS_CATALOG` /
`DATABRICKS_SCHEMA` (set in `app.yaml`); the dev loop reads the same
two vars from `.env`. See **Swap workspaces** below.

| Volume                | Read/Write | Purpose                                                          |
| --------------------- | ---------- | ---------------------------------------------------------------- |
| `frames`              | RW         | Captured frames written by the Upload / Live pages.              |
| `frames_inbox`        | R          | Drop-zone for the pipeline simulator.                            |
| `sample_videos`       | R          | Looped MP4s used by the model demo pages. Synced by `scripts/sync-sample-videos.sh`. |
| `presenter_content`   | R          | Talk-track markdown + standalone HTML deck. Synced by `scripts/sync-presenter-content.sh` (refreshable without an app redeploy). |

## Setup

### Prerequisites

- Node 22+ with `npm`.
- Databricks CLI configured with a profile that matches the bundle's
  workspace host (`databricks.yml::targets.dev.workspace.host`). Auth
  resolves by host match, so the profile name doesn't matter.
- A SQL Warehouse (default `databricks.yml::variables.warehouse_id`).
- A Lakebase Autoscaling project + branch (default
  `projects/lens-iq/branches/production`, database
  `databricks.yml::variables.lakebase_database`).
- A Claude foundation-model serving endpoint (default
  `databricks-claude-opus-4-7`).

### Install + seed

```bash
npm install

# Stand up catalog / schema / volumes / synthetic tables.
databricks bundle validate
databricks bundle run lens-iq-seed -t dev

# Deploy the per-detector serving endpoints (each is ~3-5 min cold start).
databricks bundle run pizza_vision_deploy_yolo            -t dev
databricks bundle run lensiq_deploy_roboflow_detectors    -t dev
databricks bundle run lensiq_deploy_fog_detector          -t dev
databricks bundle run lensiq_deploy_face_recognition      -t dev
```

### Run locally

```bash
./dev.sh                       # plain dev loop, assumes setup done
./dev.sh --seed                # also runs the seed bundle job first
./dev.sh --deploy-yolo         # also deploys the YOLO endpoint
./dev.sh --pipeline            # also kicks off pipeline + simulator on the workspace
# → http://localhost:8000
```

`dev.sh` reads `.env`. The vars it expects come straight from the
workspace bindings the deployed app would see:

```
DATABRICKS_HOST=...
DATABRICKS_CONFIG_PROFILE=DEFAULT
DATABRICKS_WAREHOUSE_ID=...
DATABRICKS_SERVING_ENDPOINT_LLM=databricks-claude-opus-4-7
DATABRICKS_SERVING_ENDPOINT_DETECTOR=lensiq-detector
DATABRICKS_SERVING_ENDPOINT_LICENSE_PLATE=lensiq-license-plate
DATABRICKS_SERVING_ENDPOINT_SLIP_FALL=lensiq-slip-fall
DATABRICKS_SERVING_ENDPOINT_FOG_DETECTOR=lensiq-fog-detector
DATABRICKS_SERVING_ENDPOINT_FACE_RECOGNITION=lensiq-face-recognition
DATABRICKS_CATALOG=retail_consumer_goods
DATABRICKS_SCHEMA=lens_iq
DATABRICKS_VOLUME_FRAMES=/Volumes/<catalog>/<schema>/frames
DATABRICKS_VOLUME_INBOX=/Volumes/<catalog>/<schema>/frames_inbox
DATABRICKS_VOLUME_SAMPLE_VIDEOS=/Volumes/<catalog>/<schema>/sample_videos
DATABRICKS_VOLUME_PRESENTER_CONTENT=/Volumes/<catalog>/<schema>/presenter_content
LAKEBASE_ENDPOINT=projects/lens-iq/branches/production/endpoints/<endpoint>
```

The public tunnel below is for the deployed app only; it does not
attach to `npm run dev`.

## Deploying

`scripts/deploy.sh` is the one entry point - fresh workspace or
nth redeploy, same command. Every step is idempotent so re-runs are a
fast no-op for anything already in place.

```bash
scripts/deploy.sh              # full deploy against the dev target
scripts/deploy.sh -t dev       # explicit target
scripts/deploy.sh --bundle-only  # only run `databricks bundle deploy`
scripts/deploy.sh --skip-sync    # skip volume byte uploads
scripts/deploy.sh --skip-grants  # skip Lakebase PUBLIC grants
scripts/deploy.sh --skip-genie   # skip Genie space create
scripts/deploy.sh --skip-jobs    # skip per-detector deploy jobs
scripts/deploy.sh --skip-run     # skip the final `bundle run lens_iq`
```

What the script chains, in order (see `scripts/deploy.sh --help` for
the same list with rationale):

1. **`databricks bundle deploy`** creates everything DABs natively
   supports - in a brand-new workspace, this single call provisions:
   - UC catalog `retail_consumer_goods` (`resources/catalog.yml`)
   - UC schema `lens_iq` (`resources/schema.yml`)
   - UC volumes `frames`, `frames_inbox`, `sample_videos`,
     `presenter_content` (`resources/volumes.yml`)
   - Serverless SQL warehouse `lensiq-warehouse`
     (`resources/warehouse.yml`)
   - Secret scope `lens-iq` (`resources/secret_scope.yml`)
   - Lakebase Autoscaling project `lens-iq` plus auto-provisioned
     `production` branch + `primary` endpoint + `databricks_postgres`
     database (`resources/lakebase.yml`)
   - App resource bindings (`resources/app.yml`) for the warehouse,
     every serving endpoint, the Lakebase database, the four volumes,
     and the portr secret
   - Lakeflow Spark Declarative Pipeline (`resources/pipeline.yml`)
   - Jobs for seed data + per-detector deploys + pipeline simulator
     (defined inline in `databricks.yml::resources.jobs`)
2. **`databricks secrets put-secret`** for `roboflow_api_key` and
   `portr_token`. Values are read from `ROBOFLOW_API_KEY` and
   `PORTR_TOKEN` env vars; empty values skip with a warning so the
   downstream deploy job (or public tunnel) fails loudly rather than
   silently shipping a half-configured endpoint.
3. **`scripts/sync-sample-videos.sh`** + **`sync-presenter-content.sh`**
   push the bytes that DABs deliberately leaves out of the bundle
   upload (MP4s > 10MB per file, talk-track markdown that re-reads at
   runtime).
4. **`scripts/grant-lakebase-schema.sh`** opens the app schema to
   PUBLIC so the app SP retains write access regardless of who created
   the schema first. See the script header for the full ownership
   rationale.
5. **`databricks genie create-space`** from
   `resources/genie_space_lensiq_detections.json` (DABs does not yet
   support a `genie_spaces` resource). The resolved space id is cached
   at `.databricks/state/genie_space_id` so subsequent runs no-op.
6. **`databricks bundle run`** for the deploy jobs - in dependency
   order, `lens-iq-seed`, `pizza_vision_deploy_yolo`,
   `lensiq_deploy_roboflow_detectors` (only if `ROBOFLOW_API_KEY` is
   set), `lensiq_deploy_fog_detector`, `lensiq_deploy_face_recognition`.
7. **`databricks bundle run lens_iq`** pushes the source code into the
   app container and starts it.

Per repo policy, no command pushes to the workspace unless you run it.

### Fresh environment (first deploy)

Single command, assuming you have the Databricks CLI authenticated to
the target workspace and `node`, `npm`, `psql`, and `jq` on your PATH:

```bash
git clone <repo> && cd dais-demos
npm install

# Tell the CLI which workspace to target. Either set DATABRICKS_CONFIG_PROFILE
# in .env (scripts/deploy.sh sources it) or use `databricks auth login` /
# the -p flag at deploy time.
cat > .env <<'ENV'
DATABRICKS_CONFIG_PROFILE=<your-profile>
DATABRICKS_CATALOG=retail_consumer_goods
DATABRICKS_SCHEMA=lens_iq
ENV

# Optional: secret values. Missing values skip with a warning; you can
# always re-run scripts/deploy.sh later with them set.
export ROBOFLOW_API_KEY=<roboflow-key>   # for license-plate + slip/fall
export PORTR_TOKEN=<portr-client-token>  # only if you want the public tunnel

scripts/deploy.sh -t dev
```

That's the whole thing. The first run takes ~10-15 minutes - most of
it is the per-detector deploy jobs warming up cold-start endpoints in
parallel. Subsequent runs are 30-60 seconds.

If your workspace already has a SQL warehouse / Lakebase project /
Claude endpoint you'd rather reuse, override per-command:

```bash
databricks bundle deploy -t dev \
  --var "warehouse_id=<id>,lakebase_database=<db_name>,llm_endpoint=<endpoint>"
```

then run `scripts/deploy.sh --bundle-only` for nothing else, or the
full script to continue the chain.

## Swap workspaces

The Unity Catalog catalog + schema are split into three layers, and a
helper script keeps them in sync:

- **DABs resources** (volumes, app binding, jobs) - resolved from
  `databricks.yml::variables.{catalog,schema}` via `${var.catalog}` /
  `${var.schema}` interpolation. Change the defaults (or pass `--var`
  at deploy time) and every YAML resource follows.
- **Runtime app code** (server constants, direct `analytics.query()`
  calls) - reads `DATABRICKS_CATALOG` / `DATABRICKS_SCHEMA` from env.
  Set in `app.yaml` for deploys, `.env` for local dev.
- **File-based artifacts that DABs can't see** - `config/queries/*.sql`,
  `notebooks/*.ipynb` widget defaults, `resources/genie_space_*.json`,
  `pipelines/pizza_vision_pipeline.py` Spark conf defaults. These have
  fully-qualified table refs baked in and need a sed pass.

`scripts/swap-uc.sh` does all three at once:

```bash
scripts/swap-uc.sh --catalog new_catalog --schema new_schema
```

It reads the current defaults out of `databricks.yml`, rewrites every
file in the three layers above, and prints the redeploy command. After
running it you still need to do the workspace-side bootstrap (`databricks
bundle deploy` + the per-detector deploy jobs) before the app can find
its tables in the new home.

The script intentionally does NOT rename bundle resource IDs
(`lens-iq-seed`, `lensiq_deploy_*`) or serving endpoint names
(`lensiq-*`); those are independent identifiers.

## Public tunnel (opt-in)

The Databricks Apps default URL goes through the workspace SSO redirect,
which makes screen-recording a demo and sharing a link with a customer
painful. To bypass that, the app can register a portr
(https://portr.dev) tunnel from inside the container and serve the same
bytes at a public HTTPS URL.

**Opt-in is via two env vars in `app.yaml`:**

```yaml
- name: PUBLIC_DOMAIN
  value: lensiq.apps.dbx.tools
- name: PORTR_TOKEN
  valueFrom: portr_token       # resource binding in resources/app.yml
```

`scripts/start.sh` reads `PUBLIC_DOMAIN` at boot and:

- Parses the leftmost dotted label as the **portr subdomain and tunnel
  name** (e.g. `lensiq.apps.dbx.tools` → subdomain `lensiq`).
- Parses the rest as the **portr server host** (e.g. `apps.dbx.tools`).
- Installs portr from `https://install.portr.dev` into the per-container
  `$HOME/.portr/bin` (idempotent across cold starts).
- Renders `~/.portr/config.yaml` from `PORTR_TOKEN` + `DATABRICKS_APP_PORT`.
- Backgrounds `portr start` alongside the node entrypoint and supervises
  both with the same SIGTERM + SIGKILL grace path.

**To opt out**, remove the `PUBLIC_DOMAIN` and `PORTR_TOKEN` entries from
`app.yaml` and the `portr_token` resource from `resources/app.yml`. With
`PUBLIC_DOMAIN` unset, `scripts/start.sh` skips the portr install
completely and just runs node. The app stays reachable at its standard
Databricks Apps workspace URL.

**To point at a different host**, change the values:

```yaml
- name: PUBLIC_DOMAIN
  value: <your-subdomain>.<your-portr-server>
- name: PORTR_TOKEN
  valueFrom: portr_token       # secret key/scope live in databricks.yml
```

The portr-server secret itself is held in the Databricks secret store -
scope and key are bundle variables
(`apps_tunnel_secret_scope` / `apps_tunnel_secret_key` in
`databricks.yml`). Update them to point at your own portr token.

## Project layout

```
.
├── server/                       AppKit server
│   ├── server.ts                 Plugins + custom routes (defined inline)
│   ├── talk-track-rewrite.ts     LLM persona rewrite + LRU cache
│   ├── vision-detector.ts        Claude vision wrapper (spills / wet floor)
│   ├── llm-response.ts           Shared chat-completion plumbing
│   └── ...
├── client/                       Vite + React SPA
│   ├── src/
│   │   ├── App.tsx               Routing, nav, role gating
│   │   ├── pages/                One file per view (see table above)
│   │   ├── components/           Charts, AI chat, global loading bar
│   │   └── lib/                  query keys, model registry, tour
│   └── public/sample-videos/     MP4s pushed to the sample_videos volume
├── config/queries/               One .sql file per analytics query key
├── docs/                         Talk track + booth deck (synced to volume)
├── notebooks/                    Seed + per-detector deploy notebooks
├── scripts/                      Deploy, start, volume-sync, grant helpers
├── resources/                    DABs resource files (app, pipeline, volumes)
├── databricks.yml                DAB entrypoint (vars, targets, jobs)
├── app.yaml                      Databricks Apps manifest
└── package.json
```

## Repo conventions

A few project-specific rules worth knowing before you edit:

- All Postgres goes through `appkit.lakebase.query(...)`. Do not import
  `pg`, `postgres`, `kysely`, or `drizzle-orm` directly.
- Routes use `asyncRoute(...)` + `zod` schemas + `HttpError`. Don't roll
  per-route try/catch envelopes.
- Bootstrap DDL goes through `onceAsync(...)` + `_runIdempotentDdl(...)`
  so it tolerates ownership skips on cold start.
- UI primitives come from `@databricks/appkit-ui/react`. Toast is
  `sonner` (`Toaster` is mounted in `client/src/main.tsx`).
- New notebooks are `.ipynb`, not the `# Databricks notebook source`
  format.

See `.cursor/rules/dry-this-repo.mdc` for the full DRY playbook.
