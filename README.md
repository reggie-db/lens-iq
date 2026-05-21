# Pizza Vision

Merged demo combining two prior demos:

- `pizza-detector/` - a Python YOLO/Ultralytics pipeline that detects pizza slices,
  vehicles, and people from images / a webcam.
- `reggie-demo-ui/iot/` - a React + Vite IoT monitoring dashboard exported from
  Figma Make.

Both originals are preserved under `.tmp/backup/` for reference. This project
is a single Databricks AppKit application that replaces the ad-hoc REST/WS
plumbing with first-class plugins.

## Architecture

```
+-----------+       useAnalyticsQuery        +-------------------+
|  React UI |  ----------------------------> |  AppKit analytics |  ---> SQL Warehouse
|  (client/)|                                +-------------------+
|           |       useServingInvoke         +-------------------+
|           |  ----------------------------> |  AppKit serving   |  ---> llm endpoint
|           |     (alias=llm)                +-------------------+      (chat completion)
|           |
|           |       fetch /api/detect        +-------------------+
|           |  ----------------------------> |  AppKit serving   |  ---> detector endpoint
|           |     (alias=detector)           +-------------------+      (YOLO bbox model)
|           |
|           |       EventSource              +-------------------+
|           |   /api/detections/stream  ---> |  Custom SSE route |  ---> detections table
|           |                                +-------------------+
+-----------+
```

### Plugins (server/server.ts)

| Plugin           | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `server()`       | Express + Vite dev / static prod                                             |
| `analytics()`    | Parameterized SQL from `config/queries/*.sql`                                |
| `serving()`      | LLM chat + YOLO detector via Model Serving                                   |
| `files()`        | UC volume `frames` (auto-mounts `/api/files/frames/raw?path=<id>.jpg`, etc.) |

### Custom routes (server/server.ts)

Wired up inline in `onPluginsReady` so the `AppKit` handle is fully typed:

| Route                          | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `POST /api/detect`             | Forwards a base64 image to `appkit.serving("detector").asUser(req)`, normalizes the response. |
| `GET  /api/detections/stream`  | SSE poller that runs `appkit.analytics.query(...)` every 2s and emits new rows. |

Frame images are served by the built-in Files plugin route, no custom wrapper.

### Auth

- Analytics queries run as the **service principal** (shared cache).
- Serving + files plugins run **on-behalf-of (OBO)** the logged-in user; user
  permissions on the serving endpoint and the volume are enforced.

## Project layout

```
.
├── server/                 AppKit server
│   └── server.ts           Plugins + custom routes (defined inline)
├── client/                 Vite + React SPA
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── pages/          One file per view
│       ├── components/     Charts + AI chat button
│       └── lib/            camera, detector, query types
├── config/
│   └── queries/            One .sql file per analytics query key
├── notebooks/
│   └── seed_data.ipynb     Synthetic data generator
├── databricks.yml          DAB with `lens_iq` app + seed job
├── app.yaml                Databricks Apps manifest
├── package.json
└── tsconfig.json
```

## Setup

### Prerequisites

- Node.js v22+ with `npm`
- Databricks CLI configured with profile `DEFAULT`
- An available SQL Warehouse and a Model Serving endpoint for chat (e.g.
  `databricks-claude-opus-4-7`)
- A YOLO detector deployed to Model Serving (see "Detector endpoint" below)

### Install + seed data

```bash
npm install

# 1. Generate synthetic data once (writes reggie_pierce_7405614800873570.pizza_vision.* tables).
databricks bundle validate
databricks bundle run pizza_vision_seed -t dev
```

### Run locally

```bash
# Copy env from databricks resources (see below).
cp .env.example .env  # if you created one
npm run dev
# -> http://localhost:8000
```

You'll need the following env vars locally (these come from the
`databricks.yml` resource bindings when the app is deployed):

```
DATABRICKS_WAREHOUSE_ID=...
DATABRICKS_SERVING_ENDPOINT_LLM=databricks-claude-opus-4-7
DATABRICKS_SERVING_ENDPOINT_DETECTOR=lensiq-detector
DATABRICKS_VOLUME_FRAMES=/Volumes/users/pizza_vision/frames
DATABRICKS_HOST=...
DATABRICKS_TOKEN=...   # OR DATABRICKS_CONFIG_PROFILE=DEFAULT
```

### Detector endpoint

The `detector` serving alias points to a YOLO endpoint that accepts a
base64-encoded image and returns predictions. To produce one:

1. Log the YOLO weights from the original `pizza-detector/` project as an MLflow
   PyFunc model that wraps `ultralytics.YOLO(...)` and returns
   `[{label, confidence, bbox}, ...]`.
2. Register and deploy to Model Serving as `lensiq-detector`.
3. Update `databricks.yml::variables.detector_endpoint` if the name differs.

Until that exists the Live and Upload pages will surface a 502 with the
serving error - everything else works against the synthetic warehouse data.

## Deploying

(Not done automatically. Run the commands yourself when ready.)

```bash
databricks bundle validate -t dev
databricks bundle deploy   -t dev
databricks apps deploy lens-iq -t dev
```
