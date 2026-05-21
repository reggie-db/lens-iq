import { Readable } from "node:stream";
import { analytics, createApp, files, serving, server, sql } from "@databricks/appkit";
import { MODELS, getModel, DEFAULT_MODEL_ID } from "../client/src/lib/models.ts";
import { SAMPLE_VIDEOS, getSampleVideo } from "../client/src/lib/samples.ts";
import { getServingStatus } from "./serving-status.ts";

// LensIQ AppKit server.
//
// Plugins:
//   - server(): Express + Vite middleware (dev) / static (prod).
//   - analytics(): file-based SQL queries against the SQL warehouse.
//   - serving({ llm, detector, roboflow_detector }): proxies to Databricks
//     Model Serving endpoints, called on behalf of the end user (OBO).
//       * detector           - single-model YOLO PyFunc (general objects).
//       * roboflow_detector  - multi-model Roboflow PyFunc that dispatches by
//                              `model_id` (license plate, spill, wet floor,
//                              cigarette/vape, slip & fall).
//   - files({ volumes: { frames } }): Unity Catalog volume for stored frames.
//     Auto-mounts /api/files/frames/raw?path=<id>.jpg for image bytes.
//
// Additional custom routes wired up below:
//   - GET  /api/models             : Returns the shared MODELS registry so the
//                                    UI can render its selector.
//   - POST /api/detect             : Detection proxy. `model` selects an entry
//                                    from the MODELS registry; the server
//                                    invokes the model's serving alias and
//                                    passes `model_id` for the multi-model
//                                    endpoint. With { persist: true } the
//                                    frame is also uploaded to the `frames`
//                                    volume and a row per detection is
//                                    inserted into the detections table.
//   - GET  /api/detections/stream  : SSE feed of newly inserted detection rows.

const POLL_INTERVAL_MS = 2000;
const SSE_HEARTBEAT_MS = 15_000;
const TABLE_DETECTIONS = "reggie_pierce_7405614800873570.pizza_vision.detections";
const STORE_IDS = [
  "S-ATL-001", "S-ATL-002", "S-DAL-001", "S-HOU-001",
  "S-TAM-001", "S-TAM-002", "S-NAS-001", "S-CHA-001",
] as const;

const DETECTIONS_SINCE_SQL = `
SELECT
    id,
    frame_id,
    DATE_FORMAT(ts, "yyyy-MM-dd'T'HH:mm:ss") AS ts,
    store_id,
    label,
    class_id,
    confidence,
    bbox
FROM ${TABLE_DETECTIONS}
WHERE ts > :since
ORDER BY ts
LIMIT 200
`;

// SQL for inserting a single detection from the app. Bound parameters keep
// the statement injection-safe; bbox is built from four ints via Spark's
// `array()` constructor.
const DETECTIONS_INSERT_SQL = `
INSERT INTO ${TABLE_DETECTIONS}
(id, frame_id, ts, store_id, label, class_id, confidence, bbox)
SELECT
    :id, :frame_id, CAST(:ts AS TIMESTAMP), :store_id, :label,
    :class_id, :confidence, array(:x1, :y1, :x2, :y2)
`;

interface DetectionRow {
  id: number;
  frame_id: string;
  ts: string;
  store_id: string;
  label: string;
  class_id: number;
  confidence: number;
  bbox: [number, number, number, number];
}

interface NormalizedDetection {
  label: string;
  class_id: number;
  confidence: number;
  bbox: [number, number, number, number];
}

interface ServingInvokeResult {
  ok: boolean;
  data?: unknown;
  status?: number;
  message?: string;
}

// Parse the YOLO / Roboflow PyFunc serving response. The deploy_yolo notebook
// returns one detection list per input row, so Model Serving commonly emits
// `{ predictions: [ [ {label, class_id, confidence, bbox} ... ] ] }`. AppKit's
// serving plugin wraps that in `{ ok, data }`. Some endpoints return the inner
// list directly as `data: [[...]]` or a flat `predictions: [{...}, ...]`.
function _extractDetectionCandidates(raw: unknown): unknown[] {
  let body: unknown = raw;
  if (raw && typeof raw === "object" && "ok" in raw) {
    const wrapped = raw as { ok: boolean; data?: unknown };
    if (!wrapped.ok) return [];
    if ("data" in wrapped) body = wrapped.data;
  }

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }

  let items: unknown[] = [];
  if (Array.isArray(body)) {
    items = body;
  } else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.predictions)) {
      items = obj.predictions;
    } else if (Array.isArray(obj.outputs)) {
      items = obj.outputs;
    }
  }

  // One list of detections per dataframe row: [[d1, d2], ...] -> [d1, d2, ...]
  if (items.length > 0 && items.every((x) => Array.isArray(x))) {
    const first = items[0] as unknown[];
    if (first.length === 0 || (first[0] != null && typeof first[0] === "object")) {
      items = items.flat();
    }
  } else if (
    items.length === 1
    && Array.isArray(items[0])
    && (items[0] as unknown[]).every((x) => x != null && typeof x === "object")
  ) {
    items = items[0] as unknown[];
  }

  return items;
}

function _bboxFromRecord(rec: Record<string, unknown>): [number, number, number, number] | null {
  if (Array.isArray(rec.bbox) && rec.bbox.length === 4) {
    return rec.bbox.map((n) => Math.round(Number(n))) as [number, number, number, number];
  }
  const keys = ["x1", "y1", "x2", "y2"] as const;
  if (keys.every((k) => typeof rec[k] === "number" || typeof rec[k] === "string")) {
    return keys.map((k) => Math.round(Number(rec[k]))) as [number, number, number, number];
  }
  return null;
}

function _normalizeDatabricks(raw: unknown): NormalizedDetection[] {
  const candidates = _extractDetectionCandidates(raw);
  const out: NormalizedDetection[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const bbox = _bboxFromRecord(rec);
    if (!bbox) continue;
    out.push({
      label: typeof rec.label === "string" ? rec.label : "object",
      class_id: typeof rec.class_id === "number" ? rec.class_id : -1,
      confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
      bbox,
    });
  }
  return out;
}

// Strip the `data:image/...;base64,` prefix that the browser canvas produces,
// returning just the base64 payload Model Serving expects.
function _stripDataUrl(image: string): string {
  const match = image.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : image;
}

// Decode a base64 image (with or without a data URL prefix) into a Buffer for
// upload to the UC volume.
function _decodeImage(image: string): Buffer | null {
  try {
    return Buffer.from(_stripDataUrl(image), "base64");
  } catch {
    return null;
  }
}

const AppKit = await createApp({
  cache: {
    enabled: true,
    ttl: 60,
    strictPersistence: false,
  },
  plugins: [
    // In dev (NODE_ENV=development), AppKit mounts Vite middleware for HMR.
    // In prod, ServerPlugin.findStaticPath() picks up client/dist/ via its
    // auto-discovery probe order (dist, client/dist, build, public, out) -
    // see client/vite.config.ts for the matching output path.
    // 8mb body limit gives plenty of headroom for high-res snapshots after
    // captureVideoFrameForDetection / resizeDataUrlForDetection downscale the
    // image client-side. Below this the Live tick stays well under 200KB; the
    // snapshot/upload path tops out around 1MB even on busy 1080p frames.
    server({ bodyLimit: "8mb" }),
    analytics({}),
    serving({
      endpoints: {
        llm: { env: "DATABRICKS_SERVING_ENDPOINT_LLM" },
        detector: { env: "DATABRICKS_SERVING_ENDPOINT_DETECTOR" },
        // Multi-model Roboflow PyFunc deployed by
        // notebooks/deploy_roboflow_models.ipynb. The PyFunc dispatches on
        // a `model_id` row column so all five Roboflow models share one
        // endpoint, one cold-start, and one MLflow registered model.
        roboflow_detector: { env: "DATABRICKS_SERVING_ENDPOINT_ROBOFLOW_DETECTOR" },
      },
    }),
    files({
      auth: "on-behalf-of-user",
      volumes: {
        // `frames` is the app-capture volume (webcam/upload) - read+write.
        frames: { policy: files.policy.allowAll() },
        // `inbox` mirrors the SDP pipeline's drop volume so the Pipeline page
        // can serve raw frames the pipeline processed via /api/files/inbox/raw.
        inbox: { policy: files.policy.publicRead() },
      },
    }),
  ],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.get("/api/models", (_req, res) => {
        res.json({
          models: MODELS.map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            provider: m.provider,
            color: m.color,
          })),
          default: DEFAULT_MODEL_ID,
        });
      });

      app.get("/api/serving-status/:alias", async (req, res) => {
        const alias = typeof req.params.alias === "string" ? req.params.alias : "";
        if (!alias) {
          res.status(400).json({ error: "Missing serving alias." });
          return;
        }
        const force = req.query.force === "1" || req.query.force === "true";
        try {
          const status = await getServingStatus(alias, { force });
          res.json(status);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Serving status failed (${alias}): ${message}` });
        }
      });

      // ─── Sample videos ──────────────────────────────────────────────────
      //
      // Roboflow hosts the `supervision` library's video assets on a CDN that
      // doesn't emit CORS headers (no Access-Control-Allow-Origin). A
      // <video crossorigin="anonymous"> pointing at those URLs would render
      // fine, but the moment we draw it into a <canvas> the canvas gets
      // "tainted" and subsequent toDataURL() calls throw a SecurityError - so
      // the Live page's detection loop can't grab frames.
      //
      // To make those assets usable, we re-host them through this proxy.
      // Range/Content-Range/Content-Length are forwarded so the browser can
      // seek smoothly. The upstream catalog lives in client/src/lib/samples.ts
      // so the client and server share one source of truth.

      app.get("/api/sample-videos", (_req, res) => {
        res.json({
          samples: SAMPLE_VIDEOS.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            models: s.models,
            url: `/api/sample-videos/${s.id}`,
          })),
        });
      });

      app.get("/api/sample-videos/:id", async (req, res) => {
        const sample = getSampleVideo(req.params.id);
        if (!sample) {
          res.status(404).json({ error: `Unknown sample id: ${req.params.id}` });
          return;
        }

        const upstreamHeaders: Record<string, string> = {};
        if (typeof req.headers.range === "string") {
          upstreamHeaders.range = req.headers.range;
        }

        let upstreamRes: Response;
        try {
          upstreamRes = await fetch(sample.upstream, { headers: upstreamHeaders });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Sample upstream failed: ${message}` });
          return;
        }

        // 200 (full body) and 206 (range response) both carry usable bytes.
        // Anything else means the upstream rejected us and there's nothing
        // useful to forward.
        if (upstreamRes.status !== 200 && upstreamRes.status !== 206) {
          res.status(upstreamRes.status).end();
          return;
        }

        const passthroughHeaders = [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "last-modified",
          "etag",
        ];
        for (const name of passthroughHeaders) {
          const value = upstreamRes.headers.get(name);
          if (value) res.setHeader(name, value);
        }
        res.setHeader("cache-control", "public, max-age=3600");
        res.status(upstreamRes.status);

        if (!upstreamRes.body) {
          res.end();
          return;
        }
        // Node's typings for Readable.fromWeb expect a node-stream/web
        // ReadableStream; the global fetch returns the slightly different DOM
        // type. They're structurally compatible at runtime so a single cast
        // is enough.
        Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      });

      app.post("/api/detect", async (req, res) => {
        const { image, conf = 0.35, iou = 0.5, persist = false, model: modelId = DEFAULT_MODEL_ID } = req.body ?? {};
        if (!image || typeof image !== "string") {
          res.status(400).json({ error: "Missing required `image` (base64 data URL or raw base64)." });
          return;
        }

        const model = getModel(typeof modelId === "string" ? modelId : DEFAULT_MODEL_ID);
        if (!model) {
          res.status(400).json({ error: `Unknown model id: ${modelId}` });
          return;
        }

        // Build the dataframe_records payload for the served PyFunc. The
        // YOLO endpoint ignores extras; the multi-model Roboflow endpoint
        // dispatches on `model_id`.
        const row: Record<string, unknown> = { image, conf, iou };
        if (model.roboflowModelId) row.model_id = model.roboflowModelId;

        let detections: NormalizedDetection[] = [];
        try {
          const result = (await appkit.serving(model.servingAlias).asUser(req).invoke({
            dataframe_records: [row],
          })) as ServingInvokeResult;
          if (!result.ok) {
            res.status(result.status ?? 502).json({
              error: `Detector failed (${model.id}): ${result.message ?? "Serving invoke failed"}`,
            });
            return;
          }
          detections = _normalizeDatabricks(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Detector failed (${model.id}): ${message}` });
          return;
        }

        let saved: { frame_id: string; url: string } | null = null;
        if (persist === true) {
          try {
            const buffer = _decodeImage(image);
            if (!buffer) throw new Error("Could not decode base64 image.");
            const frameId = `frame_${Date.now()}`;
            const fileName = `${frameId}.jpg`;
            await appkit.files("frames").asUser(req).upload(fileName, buffer, { overwrite: true });

            // Insert one row per detection so the Detections page (driven by
            // /api/detections/stream and the recent-detections query) picks
            // them up immediately. The id column is BIGINT in the seed; we
            // derive distinct ids from `Date.now() + i` to avoid collisions
            // within a single capture.
            const baseId = Date.now();
            const storeId = STORE_IDS[Math.floor(Math.random() * STORE_IDS.length)];
            const ts = new Date().toISOString();
            // All numeric columns in the seeded table are BIGINT (PySpark infers
            // Python `int` as LongType), so use sql.bigint() throughout.
            for (let i = 0; i < detections.length; i++) {
              const d = detections[i];
              await appkit.analytics.query(DETECTIONS_INSERT_SQL, {
                id: sql.bigint(baseId + i),
                frame_id: sql.string(frameId),
                ts: sql.string(ts),
                store_id: sql.string(storeId),
                label: sql.string(d.label),
                class_id: sql.bigint(d.class_id),
                confidence: sql.double(d.confidence),
                x1: sql.bigint(d.bbox[0]),
                y1: sql.bigint(d.bbox[1]),
                x2: sql.bigint(d.bbox[2]),
                y2: sql.bigint(d.bbox[3]),
              });
            }
            saved = {
              frame_id: frameId,
              url: `/api/files/frames/raw?path=${encodeURIComponent(fileName)}`,
            };
          } catch (err) {
            console.warn("Persist failed:", err);
          }
        }

        res.json({ detections, saved });
      });

      app.get("/api/detections/stream", async (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        let lastTs = new Date(Date.now() - 30_000).toISOString();
        let stopped = false;

        const writeEvent = (event: string, payload: unknown) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        writeEvent("hello", { ok: true, since: lastTs });

        const heartbeat = setInterval(() => {
          if (!stopped) res.write(": keep-alive\n\n");
        }, SSE_HEARTBEAT_MS);

        const tick = async () => {
          if (stopped) return;
          try {
            const result = await appkit.analytics.query(DETECTIONS_SINCE_SQL, {
              since: sql.timestamp(lastTs),
            });
            const rows = Array.isArray(result) ? (result as DetectionRow[]) : [];
            for (const row of rows) {
              writeEvent("detection", row);
              if (row.ts > lastTs) lastTs = row.ts;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeEvent("error", { message });
          }
        };

        const interval = setInterval(tick, POLL_INTERVAL_MS);
        void tick();

        req.on("close", () => {
          stopped = true;
          clearInterval(interval);
          clearInterval(heartbeat);
          res.end();
        });
      });
    });
  },
});

export default AppKit;
