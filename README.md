# LensIQ

![LensIQ demo](docs/assets/lensiq-demo.gif)

LensIQ turns camera feeds into governed operational data for quick-service
restaurants, convenience stores, fuel stations, and other distributed retail
operations.

## Try the running app

- [Open LensIQ on Databricks](https://lens-iq-7474652124440999.aws.databricksapps.com)

The Databricks Apps URL uses workspace authentication. The app resource is
currently running on the FEVM AWS workspace.

## Why this demo exists

Retail computer-vision projects often stop at a model demo: a bounding box
appears on a frame, but the result is disconnected from operations, analytics,
governance, and business action.

LensIQ demonstrates the complete path from camera signal to operational value:

1. Detect an event with a purpose-built or multimodal model.
2. Normalize the result into governed records.
3. Combine detections with store, device, safety, and transaction context.
4. Surface the result in an operator workflow, fleet dashboard, or alert.
5. Ask follow-up questions in natural language with governed Genie access.

The business value is not the bounding box itself. It is faster action and
measurable improvement across:

- Safety: detect spills, missing safety signage, falls, and obscured cameras.
- Service: monitor guest traffic, drive-through activity, and beverage refill
  opportunities.
- Availability: measure pizza inventory, pump availability, and camera health.
- Loss prevention and security: capture license plates and match known faces.
- Fleet operations: compare stores using the same governed event model instead
  of reviewing isolated camera systems.
- Data access: let operations teams ask LensIQ questions without needing to
  understand the underlying tables or SQL.

## Demo experience

The Fleet Operations dashboard summarizes eight synthetic stores, then each
workflow drills into a specific operational question:

- Live Detection starts with the webcam and falls back to Databricks Summit
  expo-floor footage when a camera is unavailable.
- Spill Detection measures detection, safety-sign placement, and response time.
- License Plates combines plate detection, multimodal OCR, and synthetic visit
  context.
- Guest Counts compares forecourt traffic with in-store conversion.
- Facial Recognition uses embeddings and pgvector similarity search.
- Camera Clarity identifies fogged or contaminated lenses.
- Pizza Inventory counts slices and whole pies ready for sale.
- Pump Status identifies active and bagged out-of-service dispensers.
- Beverage Service classifies glasses as full, half-full, or low.
- Ask LensIQ opens as a resizable split pane and streams Genie-backed answers,
  generated SQL, tool progress, charts, and tables.

Additional pages expose detections, alerts, device health, trends, data search,
the ingestion pipeline, image upload, and presenter materials.

## Architecture

```text
Camera, webcam, uploaded image, or sample video
                        |
                        v
React 19 + Vite + AppKit UI
                        |
                        v
Databricks AppKit server and @dbx-tools agent runtime
        |               |                 |                 |
        v               v                 v                 v
Model Serving      SQL Warehouse     UC Volumes       Lakebase
detectors + LLM    fleet analytics   media/assets     app state + pgvector
        |               |                 |                 |
        +---------------+-----------------+-----------------+
                                |
                                v
                 Unity Catalog tables + Genie
```

Custom detectors use dedicated serving aliases, while the multimodal workflows
share the `llm` alias. Results are normalized by the server before they reach
the UI or governed storage. Claude vision workflows also share an exact-frame
cache so related classifiers can reuse a model response.

## Technology

### Application

- TypeScript with strict compiler settings
- React 19 and React Router
- Vite for the local development loop and client build
- Tailwind CSS and `@databricks/appkit-ui`
- Recharts for operational visualizations
- `react-resizable-panels` for the docked Ask LensIQ workspace
- Express routes provided through the AppKit server plugin
- Server-sent events for live detections and face-match updates

### Databricks

- [Databricks Apps](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/)
  for the hosted application
- [Databricks Asset Bundles](https://docs.databricks.com/aws/en/dev-tools/bundles/)
  for resources, jobs, notebooks, and application deployment
- Databricks AppKit plugins for server, analytics, serving, files, Genie, and
  Lakebase
- Databricks Model Serving for all online model calls
- AI/BI Genie for natural-language analytics over governed tables
- Unity Catalog tables and volumes for detections and media
- Lakebase Autoscaling for application state, persistent vision cache, and
  pgvector face matching
- Databricks SQL Warehouse for fleet analytics
- Lakeflow Spark Declarative Pipelines for frame ingestion
- MLflow and Unity Catalog registered models for custom detector deployment

### Models

- Databricks-hosted Claude for agent reasoning, talk-track transformation,
  plate OCR, spills, safety signs, inventory, pump status, and beverage vision
- Ultralytics YOLO for general object detection
- InsightFace SCRFD and ArcFace for face detection and embeddings
- Pillow and NumPy for camera lens-condition classification
- Roboflow Universe weights for license-plate and slip/fall models

Roboflow is not called for per-frame inference. `ROBOFLOW_API_KEY` is used only
while building or cold-starting those two custom serving endpoints so the
Inference SDK can download model assets and metadata. Inference then runs
locally inside Databricks Model Serving.

## How `@dbx-tools` is used

LensIQ uses [dbx-tools](https://github.com/reggie-db/dbx-tools) to add an
agentic application layer on top of Databricks AppKit:

- [`@dbx-tools/appkit`](https://github.com/reggie-db/dbx-tools/tree/main/workspaces/node/appkit)
  provides the `createApp` bootstrap and automatic Lakebase endpoint
  resolution used by local development and deployment.
- [`@dbx-tools/appkit-mastra`](https://github.com/reggie-db/dbx-tools/tree/main/workspaces/node/appkit-mastra)
  defines the `fleet-analyst` Mastra agent, streaming server routes, model
  selection, memory integration, and Genie toolkit.
- [`@dbx-tools/ui-mastra`](https://github.com/reggie-db/dbx-tools/tree/main/workspaces/ui/mastra)
  provides the streaming `MastraChat` interface with tool progress, generated
  SQL, charts, model picker, and export.
- [`@dbx-tools/email`](https://github.com/reggie-db/dbx-tools/tree/main/workspaces/node/email)
  provides the approval-gated `send_email` agent tool.

The Ask LensIQ flow uses on-behalf-of-user authorization for Genie, SQL, and
serving endpoint discovery. Other application routes use the app service
principal and the resources bound in `resources/app.yml`.

## Developer guide

### Prerequisites

- Bun
- Node.js 22 or newer
- Databricks CLI authenticated to the target workspace
- `psql` and `jq` for the full Lakebase grant workflow
- An existing Unity Catalog catalog and SQL Warehouse

The current FEVM AWS environment uses:

- Profile: `FEVM-REGGIE-PIERCE-AWS`
- Catalog: `reggie_pierce_aws_catalog`
- Schema: `lens_iq`
- Warehouse: `a2171589c3905bc7`
- Lakebase endpoint:
  `projects/lens-iq/branches/production/endpoints/primary`
- Genie space: `01f186bee4ce16f1ac00f8b0df1c88d6`

### Install and configure

```bash
bun install
cp .example.env .env
databricks current-user me -p FEVM-REGGIE-PIERCE-AWS
```

`.example.env` contains the current non-secret FEVM AWS defaults and blank
placeholders for optional secrets. Never commit `.env`.

For Lakebase, leave `PGHOST` and `PGDATABASE` unset. The `@dbx-tools/appkit`
bootstrap resolves both from `LAKEBASE_ENDPOINT` in the selected workspace.
Hardcoding a host from another workspace causes OAuth tokens to be rejected as
Postgres password-authentication failures.

### Run locally

The direct development loop is:

```bash
bun run dev
# http://localhost:8000
```

The preflight wrapper can validate workspace resources and optionally run
bundle jobs before starting the same Bun development command:

```bash
./dev.sh
./dev.sh --seed
./dev.sh --deploy-yolo
./dev.sh --pipeline
```

Local development keeps Mastra persistence in memory because deployed
Postgres tables can be owned by the app service principal. Genie remains
available locally and uses the configured Databricks profile.

### Validate changes

```bash
bun run typecheck
bun run build
databricks bundle validate -t dev -p FEVM-REGGIE-PIERCE-AWS
```

The local package manager is Bun. `package.json` scripts remain npm-compatible
because Databricks Apps runs `npm run build` inside the deployment container.
Lockfiles are excluded from the bundle so local registry URLs are never shipped
to Databricks Apps.

### Data and model setup

```bash
databricks bundle run lens-iq-seed -t dev -p FEVM-REGGIE-PIERCE-AWS
databricks bundle run pizza_vision_deploy_yolo -t dev -p FEVM-REGGIE-PIERCE-AWS
databricks bundle run lensiq_deploy_roboflow_detectors -t dev -p FEVM-REGGIE-PIERCE-AWS
databricks bundle run lensiq_deploy_fog_detector -t dev -p FEVM-REGGIE-PIERCE-AWS
databricks bundle run lensiq_deploy_face_recognition -t dev -p FEVM-REGGIE-PIERCE-AWS
```

The Roboflow deployment job requires `ROBOFLOW_API_KEY`. It stores the key in a
Databricks secret and uses it only to acquire model assets. The main app does
not read this key.

### Deploy

`scripts/deploy.sh` is the supported deployment entry point:

```bash
scripts/deploy.sh -t dev --seed
```

It:

1. Validates the existing catalog and warehouse.
2. Deploys the schema, volumes, secret scope, Lakebase project, jobs, pipeline,
   and app resource bindings.
3. Stores configured secret values.
4. Syncs sample videos and presenter content to Unity Catalog volumes.
5. Applies Lakebase schema grants.
6. Runs the synthetic seed job when `--seed` is set.
7. Creates or updates the Genie space.
8. Grants Unity Catalog, Genie, and serving access to the app service
   principal and to workspace users (`scripts/grant-app-access.sh`).
9. Runs model deployment jobs for endpoints that are not already ready.
10. Deploys and starts the Databricks App.

Useful controls:

```bash
scripts/deploy.sh --bundle-only
scripts/deploy.sh --skip-sync
scripts/deploy.sh --skip-grants
scripts/deploy.sh --skip-genie
scripts/deploy.sh --skip-app-grants
scripts/deploy.sh --skip-jobs
scripts/deploy.sh --skip-run
```

The script is idempotent. The Unity Catalog catalog and SQL Warehouse are
workspace-level prerequisites and are not created by this bundle.

Detailed deployment and troubleshooting steps live in
[`DEPLOY_INSTRUCTIONS.md`](DEPLOY_INSTRUCTIONS.md).

### Move to another workspace

Use the repository helper to keep runtime config, bundle defaults, notebooks,
pipeline defaults, and Genie table references aligned:

```bash
scripts/swap-uc.sh \
  --catalog <catalog> \
  --schema <schema> \
  --genie-space-id <space-id>
```

The helper rewrites the catalog, schema, volume paths, and optional Genie ID.
Update the remaining workspace-specific profile, warehouse, and secrets in
`.env`, validate the bundle, and run the deployment script.

## Repository layout

```text
client/                 React application, pages, components, and hooks
server/                 AppKit server, routes, serving, cache, and agent wiring
config/queries/         Parameterized SQL templates rendered at server boot
notebooks/              Data seed and custom model deployment notebooks
pipelines/              Lakeflow Spark Declarative Pipeline source
resources/              Bundle resources for app, schema, volumes, and Lakebase
scripts/                Deploy, sync, grant, startup, and workspace-swap tools
docs/                   Presenter talk tracks and supporting demo material
databricks.yml          Asset Bundle entry point
app.yaml                Databricks Apps runtime configuration
.example.env            Local and deploy-time environment template
```

## Engineering conventions

- Use `appkit.lakebase.query(...)` for every Postgres operation.
- Define routes with `asyncRoute`, Zod schemas, and `HttpError`.
- Run bootstrap DDL through `onceAsync` and `_runIdempotentDdl`.
- Use `buildBatchInsert` for multi-row inserts.
- Use AppKit UI primitives and Sonner notifications.
- Reuse the existing detection, webcam, and sample-video hooks.
- Create and edit notebooks as `.ipynb`.
- Use Bun for local dependency and script commands.
