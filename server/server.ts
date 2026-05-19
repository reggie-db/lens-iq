import { analytics, createApp, files, serving, server, sql } from "@databricks/appkit";

// Pizza Vision AppKit server.
//
// Plugins:
//   - server(): Express + Vite middleware (dev) / static (prod).
//   - analytics(): file-based SQL queries against the SQL warehouse.
//   - serving({ llm, detector }): proxies to Databricks Model Serving endpoints,
//     called on behalf of the end user (OBO) by default. The detector alias
//     points at the YOLO endpoint deployed by notebooks/deploy_yolo.ipynb.
//   - files({ volumes: { frames } }): Unity Catalog volume for stored frames.
//     Auto-mounts /api/files/frames/raw?path=<id>.jpg for image bytes.
//
// Additional custom routes wired up below:
//   - POST /api/detect             : Run a single image through the YOLO
//                                    detector endpoint and normalize the
//                                    response. With { persist: true } the
//                                    frame is also uploaded to the `frames`
//                                    volume and a row per detection is
//                                    inserted into the `detections` table,
//                                    so the Detections page and warehouse-
//                                    backed dashboards reflect captures
//                                    from the demo UI.
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

// Parse the YOLO PyFunc serving response. The deploy_yolo notebook configures
// the PyFunc to return one detection list per input row, so Model Serving
// produces `{ predictions: [ [ {label, class_id, confidence, bbox} ... ] ] }`.
// AppKit's serving plugin wraps the model response one more time in
// `{ ok, data }`, so we unwrap that first. We also accept the legacy shapes
// (bare array or `{predictions: [...]}`) for robustness.
function _normalize(raw: unknown): NormalizedDetection[] {
  // Unwrap AppKit's `{ok, data}` envelope when present.
  let body: unknown = raw;
  if (raw && typeof raw === "object" && "data" in raw && "ok" in raw) {
    body = (raw as { data: unknown }).data;
  }

  let candidates: unknown[] = [];
  if (Array.isArray(body)) {
    candidates = body;
  } else if (body && typeof body === "object" && "predictions" in body) {
    const preds = (body as { predictions: unknown }).predictions;
    if (Array.isArray(preds)) {
      // Model Serving wraps the PyFunc output in `predictions: [...]`. If the
      // first element is itself an array, the PyFunc returned per-row lists
      // (our case). Otherwise the first element is already a detection dict.
      candidates = Array.isArray(preds[0]) ? (preds[0] as unknown[]) : preds;
    }
  }

  const out: NormalizedDetection[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const bbox = Array.isArray(rec.bbox) && rec.bbox.length === 4
      ? (rec.bbox.map((n) => Math.round(Number(n))) as [number, number, number, number])
      : null;
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

// Decode a base64 image (with or without a data URL prefix) into a Buffer.
function _decodeImage(image: string): Buffer | null {
  const match = image.match(/^data:[^;]+;base64,(.+)$/);
  const base64 = match ? match[1] : image;
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

const AppKit = await createApp({
  plugins: [
    // In dev (NODE_ENV=development), AppKit mounts Vite middleware for HMR.
    // In prod, ServerPlugin.findStaticPath() picks up client/dist/ via its
    // auto-discovery probe order (dist, client/dist, build, public, out) -
    // see client/vite.config.ts for the matching output path.
    server(),
    analytics({}),
    serving({
      endpoints: {
        llm: { env: "DATABRICKS_SERVING_ENDPOINT_LLM" },
        detector: { env: "DATABRICKS_SERVING_ENDPOINT_DETECTOR" },
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
      app.post("/api/detect", async (req, res) => {
        const { image, conf = 0.35, iou = 0.5, persist = false } = req.body ?? {};
        if (!image || typeof image !== "string") {
          res.status(400).json({ error: "Missing required `image` (base64 data URL or raw base64)." });
          return;
        }
        if (!process.env.DATABRICKS_SERVING_ENDPOINT_DETECTOR) {
          res.status(503).json({
            error: "Detector serving endpoint is not configured. Run `databricks bundle run pizza_vision_deploy_yolo -t dev` to create it.",
          });
          return;
        }

        let detections: NormalizedDetection[] = [];

        try {
          const raw = await appkit.serving("detector").asUser(req).invoke({
            dataframe_records: [{ image, conf, iou }],
          });
          detections = _normalize(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(502).json({ error: `Detector serving failed: ${message}` });
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
