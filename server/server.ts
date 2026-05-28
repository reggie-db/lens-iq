import { Readable } from "node:stream";
import { analytics, createApp, files, lakebase, serving, server, sql } from "@databricks/appkit";
import { MODELS, getModel, DEFAULT_MODEL_ID } from "../client/src/lib/models.ts";
import { SAMPLE_VIDEOS, getSampleVideo } from "../client/src/lib/samples.ts";
import { getServingStatus } from "./serving-status.ts";

// LensIQ AppKit server.
//
// Plugins:
//   - server(): Express + Vite middleware (dev) / static (prod).
//   - analytics(): file-based SQL queries against the SQL warehouse.
//   - serving({ llm, detector, license_plate, spill, wet_floor_sign,
//               cigarette_vape, slip_fall, fog_detector }):
//     One Databricks Model Serving endpoint per use case. Each alias is
//     bound to its own UC registered model + endpoint. All invocations are
//     on behalf of the end user (OBO). The model selected by the client
//     maps 1:1 to its `servingAlias` (see client/src/lib/models.ts).
//   - files({ volumes: { frames } }): Unity Catalog volume for stored frames.
//     Auto-mounts /api/files/frames/raw?path=<id>.jpg for image bytes.
//
// Additional custom routes wired up below:
//   - GET  /api/models             : Returns the shared MODELS registry so the
//                                    UI can render its selector.
//   - POST /api/detect             : Detection proxy. `model` selects an entry
//                                    from the MODELS registry; the server
//                                    invokes that model's serving alias
//                                    directly (no dispatch layer). With
//                                    { persist: true } the frame is also
//                                    uploaded to the `frames` volume and a
//                                    row per detection is inserted into the
//                                    detections table.
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

// Pull the assistant text out of a Databricks chat-completions response. The
// llm endpoint returns OpenAI-shaped JSON: choices[0].message.content can be
// either a plain string or an array of content blocks (`type: "text"`). The
// vision-image variant returns the text block in the array form.
function _extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message as Record<string, unknown> | undefined;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join(" ");
  }
  return "";
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
        // One endpoint per detector use case. Aliases must match the
        // `servingAlias` values in client/src/lib/models.ts so the
        // /api/detect handler can look up the right endpoint by model id.
        detector: { env: "DATABRICKS_SERVING_ENDPOINT_DETECTOR" },
        license_plate: { env: "DATABRICKS_SERVING_ENDPOINT_LICENSE_PLATE" },
        spill: { env: "DATABRICKS_SERVING_ENDPOINT_SPILL" },
        wet_floor_sign: { env: "DATABRICKS_SERVING_ENDPOINT_WET_FLOOR_SIGN" },
        cigarette_vape: { env: "DATABRICKS_SERVING_ENDPOINT_CIGARETTE_VAPE" },
        slip_fall: { env: "DATABRICKS_SERVING_ENDPOINT_SLIP_FALL" },
        fog_detector: { env: "DATABRICKS_SERVING_ENDPOINT_FOG_DETECTOR" },
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
    // Lakebase Postgres backs persistent app-side state (e.g. guest_counts).
    // Resource binding lives in app.yaml; env vars PGHOST / PGDATABASE /
    // LAKEBASE_ENDPOINT are wired by the platform at deploy time and by
    // dev.sh locally. Service-principal pool (no asUser) since we only ever
    // write app-aggregated counts, never per-user data.
    lakebase(),
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
            // Exposed so the mobile capture page can target the right alias
            // when polling /api/serving-status for cold-start UX.
            servingAlias: m.servingAlias,
          })),
          default: DEFAULT_MODEL_ID,
        });
      });

      // /mobile is the canonical entry point for the phone-camera capture
      // page. The actual asset is /mobile.html (statically served from
      // client/public in dev / client/dist in prod); this alias just keeps
      // QR-codes and shared links readable.
      app.get("/mobile", (_req, res) => {
        res.redirect(302, "/mobile.html");
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
            url: s.local ? `/sample-videos/${s.local}` : `/api/sample-videos/${s.id}`,
          })),
        });
      });

      app.get("/api/sample-videos/:id", async (req, res) => {
        const sample = getSampleVideo(req.params.id);
        if (!sample) {
          res.status(404).json({ error: `Unknown sample id: ${req.params.id}` });
          return;
        }
        // Local samples are served same-origin via /sample-videos/<file>; the
        // client should never proxy them through here. If it does, hint at the
        // right URL instead of falling through into a broken fetch.
        if (!sample.upstream) {
          res.status(400).json({
            error: `Sample ${sample.id} is local; fetch it from /sample-videos/${sample.local}`,
          });
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

        // Build the dataframe_records payload for the served PyFunc.
        // Every detector endpoint hosts exactly one model so there is no
        // dispatch column - the alias alone routes to the right endpoint.
        // `iou` is YOLO-only but the Roboflow + fog PyFuncs ignore unknown
        // row columns, so it's safe to send unconditionally.
        const row: Record<string, unknown> = { image, conf, iou };

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

      // Guest-count persistence backed by Lakebase Postgres. The Guests page
      // posts batched zone counts here; the time-series chart reads recent
      // buckets back out.
      app.post("/api/guest-counts", async (req, res) => {
        const body = req.body as { batch?: Array<{ source_id?: unknown; zone?: unknown; person_count?: unknown; store_id?: unknown }> } | undefined;
        const batch = Array.isArray(body?.batch) ? body!.batch : null;
        if (!batch || batch.length === 0) {
          res.status(400).json({ error: "Body must include non-empty `batch`." });
          return;
        }
        if (batch.length > 200) {
          res.status(413).json({ error: "Batch too large (max 200 rows)." });
          return;
        }
        // Build a single multi-row INSERT with parameter placeholders so we
        // round-trip the database once per batch instead of per-row.
        const params: unknown[] = [];
        const placeholders: string[] = [];
        for (const row of batch) {
          const source_id = typeof row.source_id === "string" ? row.source_id : null;
          const zone = typeof row.zone === "string" ? row.zone : null;
          const count = typeof row.person_count === "number" && row.person_count >= 0 ? Math.floor(row.person_count) : null;
          const store_id = typeof row.store_id === "string" ? row.store_id : null;
          if (!source_id || !zone || count === null) {
            res.status(400).json({ error: "Each row needs source_id (string), zone (string), person_count (non-negative int)." });
            return;
          }
          const base = params.length;
          params.push(source_id, zone, count, store_id);
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        }
        const stmt = `INSERT INTO guest_counts (source_id, zone, person_count, store_id) VALUES ${placeholders.join(", ")}`;
        try {
          const result = await appkit.lakebase.query(stmt, params);
          res.json({ inserted: result.rowCount ?? 0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase insert failed: ${message}` });
        }
      });

      // License plate OCR. The Plates page sends a cropped image (typically
      // the bbox region returned by the Roboflow license_plate detector). We
      // forward it to the llm endpoint as a Claude vision chat completion
      // and return the extracted text. Kept deliberately small (max 24 tokens,
      // temperature 0) so the model doesn't editorialize - just the chars.
      app.post("/api/plate-ocr", async (req, res) => {
        const body = req.body as { image?: unknown } | undefined;
        const image = typeof body?.image === "string" ? body.image : null;
        if (!image) {
          res.status(400).json({ error: "Body must include `image` as a data URL or base64 string." });
          return;
        }
        const dataUrl = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
        // We ask Claude for two things at once:
        //   1. The plate text (alphanumeric chars only).
        //   2. A normalized [0,1] bbox around the plate within the supplied
        //      image so the client can render a tight overlay on the plate
        //      instead of the whole vehicle.
        // Response format is JSON only so we can parse without regex tricks.
        const prompt = [
          "You're a license plate OCR helper looking at a still image from a security camera.",
          "Find the license plate in this image and read the characters printed on it.",
          "Respond with a single line of JSON exactly matching this schema and nothing else:",
          '{"plate":"<chars>","bbox":[x1,y1,x2,y2]}',
          "where <chars> is the alphanumeric plate text (uppercased, no spaces or punctuation, jurisdiction text and slogans excluded), and bbox is the plate location as normalized fractions of the image dimensions (each value between 0 and 1, x1<x2, y1<y2).",
          'If you cannot identify the plate at all, respond with: {"plate":"UNREADABLE","bbox":null}',
        ].join(" ");
        try {
          const result = (await appkit.serving("llm").asUser(req).invoke({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
            max_tokens: 80,
          })) as { ok: boolean; status?: number; message?: string; data?: unknown };
          if (!result.ok) {
            res.status(result.status ?? 502).json({ error: result.message ?? "OCR failed" });
            return;
          }
          const raw = _extractChatText(result.data).trim();
          // Try to parse the JSON. Be lenient about leading/trailing chars
          // (e.g. accidental ```json fences).
          const jsonStart = raw.indexOf("{");
          const jsonEnd = raw.lastIndexOf("}");
          let plateText: string | null = null;
          let plateBbox: [number, number, number, number] | null = null;
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            try {
              const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { plate?: unknown; bbox?: unknown };
              if (typeof parsed.plate === "string") {
                const cleaned = parsed.plate.replace(/[^A-Z0-9]/gi, "").toUpperCase();
                if (cleaned.length >= 3 && cleaned !== "UNREADABLE") plateText = cleaned;
              }
              if (Array.isArray(parsed.bbox) && parsed.bbox.length === 4 && parsed.bbox.every((v) => typeof v === "number")) {
                const [x1, y1, x2, y2] = parsed.bbox as number[];
                if (x1 >= 0 && y1 >= 0 && x2 <= 1 && y2 <= 1 && x1 < x2 && y1 < y2) {
                  plateBbox = [x1, y1, x2, y2];
                }
              }
            } catch {
              // Fall through with nulls - the raw value still goes back so
              // the UI can show why a read was dropped.
            }
          }
          res.json({
            plate_text: plateText,
            plate_bbox: plateBbox,
            raw,
            model: process.env.DATABRICKS_SERVING_ENDPOINT_LLM ?? null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `OCR call failed: ${message}` });
        }
      });

      // Persist a plate read from the client (after OCR). Separate from
      // /api/plate-ocr so the client can batch successful reads even if the
      // OCR happens at a different cadence than the persistence flush.
      app.post("/api/plate-reads", async (req, res) => {
        const body = req.body as { batch?: Array<{ source_id?: unknown; plate_text?: unknown; confidence?: unknown; ocr_model?: unknown; detection_confidence?: unknown }> } | undefined;
        const batch = Array.isArray(body?.batch) ? body!.batch : null;
        if (!batch || batch.length === 0) {
          res.status(400).json({ error: "Body must include non-empty `batch`." });
          return;
        }
        if (batch.length > 100) {
          res.status(413).json({ error: "Batch too large (max 100 rows)." });
          return;
        }
        const params: unknown[] = [];
        const placeholders: string[] = [];
        for (const row of batch) {
          const source_id = typeof row.source_id === "string" ? row.source_id : null;
          const plate_text = typeof row.plate_text === "string" ? row.plate_text.toUpperCase() : null;
          const confidence = typeof row.confidence === "number" && row.confidence >= 0 ? row.confidence : null;
          const ocr_model = typeof row.ocr_model === "string" ? row.ocr_model : null;
          const det_conf = typeof row.detection_confidence === "number" ? row.detection_confidence : null;
          if (!source_id || !plate_text || confidence === null) {
            res.status(400).json({ error: "Each row needs source_id, plate_text, confidence." });
            return;
          }
          const base = params.length;
          params.push(source_id, plate_text, confidence, ocr_model, det_conf);
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        }
        const stmt = `INSERT INTO plate_reads (source_id, plate_text, confidence, ocr_model, detection_confidence) VALUES ${placeholders.join(", ")}`;
        try {
          const result = await appkit.lakebase.query(stmt, params);
          res.json({ inserted: result.rowCount ?? 0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase insert failed: ${message}` });
        }
      });

      app.get("/api/plate-reads/recent", async (req, res) => {
        const limitRaw = Number(req.query.limit ?? 50);
        const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
        try {
          const result = await appkit.lakebase.query<{ id: number; ts: string; source_id: string; plate_text: string; confidence: number; ocr_model: string | null; detection_confidence: number | null }>(
            "SELECT id, ts, source_id, plate_text, confidence, ocr_model, detection_confidence FROM plate_reads ORDER BY ts DESC LIMIT $1",
            [limit],
          );
          res.json({ rows: result.rows });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase query failed: ${message}` });
        }
      });

      // ─── Camera health / fog observations ─────────────────────────────
      //
      // The Camera Health page (CameraHealth.tsx) hits the fog_detector
      // endpoint per tick on two side-by-side CCTV feeds and POSTs one
      // observation row per feed per tick here. The chart re-aggregates
      // these rows back out with AVG to plot "fogged area %" per camera
      // over time, proving the end-to-end persistence path the same way
      // guest_counts does for the Guests page.
      //
      // Table is created lazily on first POST so the demo works on a
      // fresh Lakebase project without any manual migration.
      let _fogTableEnsured = false;
      const _ensureFogTable = async () => {
        if (_fogTableEnsured) return;
        await appkit.lakebase.query(`
          CREATE TABLE IF NOT EXISTS fog_observations (
            id           BIGSERIAL PRIMARY KEY,
            ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_id    TEXT NOT NULL,
            camera_label TEXT NOT NULL,
            fogged       BOOLEAN NOT NULL,
            region_count INT NOT NULL DEFAULT 0,
            area_pct     REAL NOT NULL DEFAULT 0
          )
        `);
        await appkit.lakebase.query(
          "CREATE INDEX IF NOT EXISTS idx_fog_observations_ts ON fog_observations (ts DESC)",
        );
        await appkit.lakebase.query(
          "CREATE INDEX IF NOT EXISTS idx_fog_observations_source_ts ON fog_observations (source_id, ts DESC)",
        );
        _fogTableEnsured = true;
      };

      app.post("/api/fog-observations", async (req, res) => {
        const body = req.body as {
          batch?: Array<{
            source_id?: unknown;
            camera_label?: unknown;
            fogged?: unknown;
            region_count?: unknown;
            area_pct?: unknown;
          }>;
        } | undefined;
        const batch = Array.isArray(body?.batch) ? body!.batch : null;
        if (!batch || batch.length === 0) {
          res.status(400).json({ error: "Body must include non-empty `batch`." });
          return;
        }
        if (batch.length > 400) {
          res.status(413).json({ error: "Batch too large (max 400 rows)." });
          return;
        }
        const params: unknown[] = [];
        const placeholders: string[] = [];
        for (const row of batch) {
          const source_id = typeof row.source_id === "string" ? row.source_id : null;
          const camera_label = typeof row.camera_label === "string" ? row.camera_label : null;
          const fogged = typeof row.fogged === "boolean" ? row.fogged : null;
          const region_count = typeof row.region_count === "number" && row.region_count >= 0
            ? Math.floor(row.region_count) : null;
          const area_pct = typeof row.area_pct === "number" && row.area_pct >= 0
            ? Math.min(100, row.area_pct) : null;
          if (!source_id || !camera_label || fogged === null || region_count === null || area_pct === null) {
            res.status(400).json({
              error: "Each row needs source_id, camera_label, fogged, region_count, area_pct.",
            });
            return;
          }
          const base = params.length;
          params.push(source_id, camera_label, fogged, region_count, area_pct);
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        }
        const stmt = `INSERT INTO fog_observations (source_id, camera_label, fogged, region_count, area_pct) VALUES ${placeholders.join(", ")}`;
        try {
          await _ensureFogTable();
          const result = await appkit.lakebase.query(stmt, params);
          res.json({ inserted: result.rowCount ?? 0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase insert failed: ${message}` });
        }
      });

      app.get("/api/fog-observations/recent", async (req, res) => {
        const windowSecRaw = Number(req.query.windowSec ?? 600);
        const windowSec = Number.isFinite(windowSecRaw)
          ? Math.min(86_400, Math.max(60, Math.floor(windowSecRaw))) : 600;
        const bucketSecRaw = Number(req.query.bucketSec ?? 30);
        const bucketSec = Number.isFinite(bucketSecRaw)
          ? Math.min(3_600, Math.max(5, Math.floor(bucketSecRaw))) : 30;
        // Same bucketing pattern as guest_counts: floor(ts / bucketSec) * bucketSec
        // gives us aligned buckets we can group by. AVG over the bucket so the
        // y-axis stays "% of frame fogged" instead of "samples taken".
        const stmt = `
          SELECT
            source_id,
            camera_label,
            to_timestamp(floor(extract(epoch FROM ts) / $1) * $1) AS bucket_ts,
            ROUND(AVG(area_pct)::numeric, 2)::float AS avg_area_pct,
            MAX(area_pct) AS max_area_pct,
            SUM(CASE WHEN fogged THEN 1 ELSE 0 END) AS fogged_ticks,
            COUNT(*) AS total_ticks
          FROM fog_observations
          WHERE ts >= NOW() - ($2 || ' seconds')::interval
          GROUP BY source_id, camera_label, bucket_ts
          ORDER BY bucket_ts ASC, source_id ASC
        `;
        try {
          await _ensureFogTable();
          const result = await appkit.lakebase.query<{
            source_id: string;
            camera_label: string;
            bucket_ts: string;
            avg_area_pct: number;
            max_area_pct: number;
            fogged_ticks: number;
            total_ticks: number;
          }>(stmt, [bucketSec, String(windowSec)]);
          res.json({ windowSec, bucketSec, rows: result.rows });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase query failed: ${message}` });
        }
      });

      // Most-recent rows where the camera was actually fogged, used by the
      // "Recent fog events" panel on the Camera Health page.
      app.get("/api/fog-observations/incidents", async (req, res) => {
        const limitRaw = Number(req.query.limit ?? 25);
        const limit = Number.isFinite(limitRaw)
          ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 25;
        try {
          await _ensureFogTable();
          const result = await appkit.lakebase.query<{
            id: number;
            ts: string;
            source_id: string;
            camera_label: string;
            region_count: number;
            area_pct: number;
          }>(
            `SELECT id, ts, source_id, camera_label, region_count, area_pct
             FROM fog_observations
             WHERE fogged = TRUE
             ORDER BY ts DESC
             LIMIT $1`,
            [limit],
          );
          res.json({ rows: result.rows });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase query failed: ${message}` });
        }
      });

      app.get("/api/guest-counts/recent", async (req, res) => {
        const windowSecRaw = Number(req.query.windowSec ?? 600);
        const windowSec = Number.isFinite(windowSecRaw) ? Math.min(86_400, Math.max(60, Math.floor(windowSecRaw))) : 600;
        const bucketSecRaw = Number(req.query.bucketSec ?? 30);
        const bucketSec = Number.isFinite(bucketSecRaw) ? Math.min(3_600, Math.max(5, Math.floor(bucketSecRaw))) : 30;
        // Bucket by truncating timestamps into floor(ts / bucketSec) windows
        // and average the per-zone counts inside each bucket - averaging
        // (vs summing) keeps the y-axis meaning "people seen" instead of
        // "samples taken" so the chart stays interpretable when the client
        // posts at variable cadence.
        const stmt = `
          SELECT
            zone,
            to_timestamp(floor(extract(epoch FROM ts) / $1) * $1) AS bucket_ts,
            ROUND(AVG(person_count)::numeric, 2)::float AS avg_count,
            MAX(person_count) AS max_count
          FROM guest_counts
          WHERE ts >= NOW() - ($2 || ' seconds')::interval
          GROUP BY zone, bucket_ts
          ORDER BY bucket_ts ASC, zone ASC
        `;
        try {
          const result = await appkit.lakebase.query<{ zone: string; bucket_ts: string; avg_count: number; max_count: number }>(stmt, [bucketSec, String(windowSec)]);
          res.json({ windowSec, bucketSec, rows: result.rows });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Lakebase query failed: ${message}` });
        }
      });
    });
  },
});

export default AppKit;
