import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { analytics, createApp, files, lakebase, serving, server, sql } from "@databricks/appkit";
import { z } from "zod";
import { MODELS, getModel, DEFAULT_MODEL_ID } from "../client/src/lib/models.ts";
import { SAMPLE_VIDEOS, getSampleVideo } from "../client/src/lib/samples.ts";
import { getServingStatus } from "./serving-status.ts";
import { invokeServing, sendEndpointError } from "./serving-invoke.ts";
import { detectWithClaude, type VisionDetection } from "./vision-detector.ts";
import { decodeImage, toBase64Body, toDataUrl } from "./image-data-url.ts";
import { extractChatText, extractJsonObject } from "./llm-response.ts";
import { rewriteTalkTrack } from "./talk-track-rewrite.ts";
import {
  asyncRoute,
  buildBatchInsert,
  errorMiddleware,
  HttpError,
  inlineBlob,
  onceAsync,
} from "./util.ts";

const LOCAL_SAMPLE_VIDEO_DIR = resolvePath(process.cwd(), "client/public/sample-videos");
const VIDEO_CONTENT_TYPE = "video/mp4";

// Local fallback dir for presenter content. In dev we serve directly from
// docs/ so the inner loop is "save md -> reload page". In prod (Databricks
// Apps) docs/ is excluded from the source upload (see databricks.yml ->
// sync.exclude) so the volume always wins.
const LOCAL_PRESENTER_CONTENT_DIR = resolvePath(process.cwd(), "docs");

// Catalog of booth-presenter content. Each entry is one HTTP-addressable
// item the InfoPage in the UI knows how to render. Keep this list short -
// the page is a booth aid, not a docs site. The HTML deck is served as
// `text/html` (which the auto-mounted /api/files/.../raw route refuses to
// serve inline for XSS reasons), which is why this lives behind its own
// route instead of the files plugin's default mount.
interface PresenterContentDef {
  filename: string;
  contentType: string;
  label: string;
}

const PRESENTER_CONTENT: Record<string, PresenterContentDef> = {
  "talk-track": {
    filename: "dais-talk-track.md",
    contentType: "text/markdown; charset=utf-8",
    label: "Booth talk track",
  },
  "booth-deck": {
    filename: "booth-deck.html",
    contentType: "text/html; charset=utf-8",
    label: "LensIQ booth deck",
  },
};

// LensIQ AppKit server.
//
// Everything in this app runs as the app's service principal. There is no
// `asUser(req)` anywhere - the SP holds the UC + serving + warehouse grants,
// and HTTP routes never need the end user's identity for downstream calls.
// app.yaml therefore omits `user_api_scopes` entirely.
//
// Plugins:
//   - server(): Express + Vite middleware (dev) / static (prod).
//   - analytics(): file-based SQL queries against the SQL warehouse (SP).
//   - serving({ llm, detector, license_plate, spill, wet_floor_sign,
//               cigarette_vape, slip_fall, fog_detector }):
//     One Databricks Model Serving endpoint per use case. Each alias is
//     bound to its own UC registered model + endpoint. The model selected
//     by the client maps 1:1 to its `servingAlias` (see client/src/lib/models.ts).
//   - files({ volumes: { frames, inbox, sample_videos } }): UC volumes
//     (frames for app captures, inbox for the SDP pipeline, sample_videos
//     for the demo MP4 catalog). All run as SP. The `sample_videos` volume
//     is reached programmatically only - the public route is the dedicated
//     /api/sample-videos/:id below, which adds a local-disk fast path for
//     the dev devloop.
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



// Stream a local sample MP4 from client/public/sample-videos/<filename>. The
// path is constrained to LOCAL_SAMPLE_VIDEO_DIR (no traversal). HTTP Range
// requests are honored so HTML5 <video> seeking works smoothly.
// Returns true when the response was served (handler should bail out), false
// when the file does not exist locally and the caller should fall through to
// the next source. Other errors (permissions, EBADF, etc.) bubble up so the
// caller can surface them as 500.
async function _streamLocalSampleVideo(
  filename: string,
  req: import("express").Request,
  res: import("express").Response,
): Promise<boolean> {
  const fullPath = resolvePath(LOCAL_SAMPLE_VIDEO_DIR, filename);
  if (!fullPath.startsWith(`${LOCAL_SAMPLE_VIDEO_DIR}/`)) return false;

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (!stats.isFile()) return false;

  const totalSize = stats.size;
  const rangeHeader = req.headers.range;
  res.setHeader("Content-Type", VIDEO_CONTENT_TYPE);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (rangeHeader && typeof rangeHeader === "string") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const start = match[1] === "" ? 0 : Number.parseInt(match[1], 10);
      const end = match[2] === "" ? totalSize - 1 : Number.parseInt(match[2], 10);
      if (
        Number.isFinite(start) && Number.isFinite(end) &&
        start >= 0 && end < totalSize && start <= end
      ) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        res.setHeader("Content-Length", String(end - start + 1));
        createReadStream(fullPath, { start, end }).pipe(res);
        return true;
      }
      res.status(416);
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      res.end();
      return true;
    }
  }

  res.status(200);
  res.setHeader("Content-Length", String(totalSize));
  createReadStream(fullPath).pipe(res);
  return true;
}

// Volume handle shape that the AppKit files plugin's programmatic API
// exposes. Re-declared here as a structural minimum so the helper doesn't
// have to import the full `VolumeHandle` type from a deep AppKit path.
// `contents` is left as `unknown` to bridge the SDK's
// `ReadableStream<Uint8Array>` with the variance differences in TS's
// global ReadableStream lib types - we cast at the .pipe call site.
interface SampleVolume {
  download(path: string): Promise<{
    contents?: unknown;
    "content-length"?: number;
    "content-type"?: string;
  }>;
}

// Stream a presenter-content file from the local docs/ dir. Used for the
// dev inner loop so edits to docs/dais-talk-track.md show up on reload
// without re-syncing the volume. In prod docs/ is excluded from the app
// source upload, so this always misses and the volume fallback runs.
async function _streamLocalPresenterContent(
  def: PresenterContentDef,
  res: import("express").Response,
): Promise<boolean> {
  const fullPath = resolvePath(LOCAL_PRESENTER_CONTENT_DIR, def.filename);
  if (!fullPath.startsWith(`${LOCAL_PRESENTER_CONTENT_DIR}/`)) return false;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (!stats.isFile()) return false;
  res.status(200);
  res.setHeader("Content-Type", def.contentType);
  res.setHeader("Content-Length", String(stats.size));
  // The page exposes a "refresh from volume" button, so we want the browser
  // to revalidate every time it loads the page rather than serve a stale
  // copy from cache. Booth presenters edit this on the fly.
  res.setHeader("Cache-Control", "no-store");
  createReadStream(fullPath).pipe(res);
  return true;
}

// Read a presenter-content file (the source of truth for the booth
// talk track and HTML deck) as a UTF-8 string. Used by the talk-track
// rewrite route which needs the markdown bytes in process rather than
// streamed to a response. Mirrors the local-then-volume resolution order
// of the streaming variants. Returns null on miss so the caller can
// translate to a 404.
async function _readPresenterContentText(
  def: PresenterContentDef,
  volume: SampleVolume,
): Promise<string | null> {
  const local = await _readLocalPresenterContentText(def);
  if (local !== null) return local;
  return await _readVolumePresenterContentText(volume, def);
}

async function _readLocalPresenterContentText(
  def: PresenterContentDef,
): Promise<string | null> {
  const fullPath = resolvePath(LOCAL_PRESENTER_CONTENT_DIR, def.filename);
  if (!fullPath.startsWith(`${LOCAL_PRESENTER_CONTENT_DIR}/`)) return null;
  try {
    const stats = await stat(fullPath);
    if (!stats.isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return await readFile(fullPath, "utf-8");
}

async function _readVolumePresenterContentText(
  volume: SampleVolume,
  def: PresenterContentDef,
): Promise<string | null> {
  let body: Awaited<ReturnType<SampleVolume["download"]>>;
  try {
    body = await volume.download(def.filename);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("FILES_API_FILE_NOT_FOUND") || msg.includes("Not Found")) return null;
    console.warn(`presenter_content text download failed for ${def.filename}:`, msg);
    return null;
  }
  if (!body.contents) return null;
  const reader = (body.contents as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Stream a presenter-content file from the UC volume via the files plugin's
// programmatic API. Runs as the app SP (the volume is mounted with
// auth: "service-principal"). Returns false on miss so the caller can 404.
async function _streamVolumePresenterContent(
  volume: SampleVolume,
  def: PresenterContentDef,
  res: import("express").Response,
): Promise<boolean> {
  let body: Awaited<ReturnType<SampleVolume["download"]>>;
  try {
    body = await volume.download(def.filename);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("FILES_API_FILE_NOT_FOUND") || msg.includes("Not Found")) {
      return false;
    }
    console.warn(`presenter_content download failed for ${def.filename}:`, msg);
    return false;
  }
  if (!body.contents) return false;
  res.status(200);
  // Force the catalog-defined content type so the deck (HTML) renders
  // inline in the iframe instead of triggering a download the way the
  // auto-mounted /api/files/.../raw route would.
  res.setHeader("Content-Type", def.contentType);
  if (typeof body["content-length"] === "number") {
    res.setHeader("Content-Length", String(body["content-length"]));
  }
  res.setHeader("Cache-Control", "no-store");
  Readable.fromWeb(body.contents as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  return true;
}

// Stream a sample MP4 from the given UC volume handle, running as whatever
// identity the plugin resolved for the volume (service principal in this
// app - we never call .asUser here). Returns true when the volume served
// bytes, false on FILES_API_FILE_NOT_FOUND so the caller can return 404 or
// fall through. Other errors are logged + treated as "miss" so the demo
// keeps running locally when the volume is unreachable.
async function _streamVolumeSampleVideo(
  volume: SampleVolume,
  filename: string,
  res: import("express").Response,
): Promise<boolean> {
  let body: Awaited<ReturnType<SampleVolume["download"]>>;
  try {
    body = await volume.download(filename);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("FILES_API_FILE_NOT_FOUND") || msg.includes("Not Found")) {
      return false;
    }
    console.warn(`sample_videos volume download failed for ${filename}:`, msg);
    return false;
  }
  if (!body.contents) return false;

  res.status(200);
  res.setHeader("Content-Type", body["content-type"] ?? VIDEO_CONTENT_TYPE);
  if (typeof body["content-length"] === "number") {
    res.setHeader("Content-Length", String(body["content-length"]));
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  Readable.fromWeb(body.contents as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  return true;
}

// Proxy a cross-origin sample MP4 (Roboflow `supervision` reel etc.) so the
// canvas-tainting CORS problem on those CDN URLs goes away. Range headers
// are forwarded both ways so HTML5 <video> seek still works.
async function _proxyUpstreamSampleVideo(
  upstream: string,
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const upstreamHeaders: Record<string, string> = {};
  if (typeof req.headers.range === "string") {
    upstreamHeaders.range = req.headers.range;
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, { headers: upstreamHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Sample upstream failed: ${message}` });
    return;
  }

  if (upstreamRes.status !== 200 && upstreamRes.status !== 206) {
    res.status(upstreamRes.status).end();
    return;
  }

  const passthroughHeaders = [
    "content-type", "content-length", "content-range",
    "accept-ranges", "last-modified", "etag",
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
  Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
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
    //
    // host: bind to loopback in dev so the server doesn't accept connections
    // from the LAN (LAN access also breaks getUserMedia anyway since plain
    // HTTP on a non-localhost host is not a secure context). On the
    // Databricks Apps platform the runtime sets DATABRICKS_APP_PORT and we
    // need 0.0.0.0 so the platform proxy can reach the listener; NODE_ENV
    // is set to "production" in app.yaml so the prod branch picks that up.
    server({
      bodyLimit: "8mb",
      host: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
    }),
    analytics({}),
    serving({
      endpoints: {
        // llm doubles as the vision backend for spill + wet_floor_sign
        // (see server/vision-detector.ts). Those two detectors no
        // longer have their own Roboflow endpoint binding because the
        // foundation model handles both with one call per frame.
        llm: { env: "DATABRICKS_SERVING_ENDPOINT_LLM" },
        // One endpoint per remaining detector use case. Aliases must
        // match the `servingAlias` values in client/src/lib/models.ts
        // so /api/detect can look up the right endpoint by model id.
        detector: { env: "DATABRICKS_SERVING_ENDPOINT_DETECTOR" },
        license_plate: { env: "DATABRICKS_SERVING_ENDPOINT_LICENSE_PLATE" },
        cigarette_vape: { env: "DATABRICKS_SERVING_ENDPOINT_CIGARETTE_VAPE" },
        slip_fall: { env: "DATABRICKS_SERVING_ENDPOINT_SLIP_FALL" },
        fog_detector: { env: "DATABRICKS_SERVING_ENDPOINT_FOG_DETECTOR" },
        // InsightFace buffalo_l: per-frame face detect + 512-d ArcFace
        // embedding. Called from /api/face-match (live) and /api/faces
        // (one-shot upload). Matching against the enrolled `faces` table
        // happens server-side via pgvector cosine search.
        face_recognition: { env: "DATABRICKS_SERVING_ENDPOINT_FACE_RECOGNITION" },
      },
    }),
    files({
      // Volumes are reached as the app service principal. The DAB declares
      // the required READ/WRITE_VOLUME grants via `app.resources` in
      // resources/app.yml, so the SP gets the access it needs at deploy
      // time without any per-user grants. publicRead / allowAll policies
      // gate the HTTP endpoints (any authenticated app user can call them);
      // the SP is what actually touches UC underneath.
      auth: "service-principal",
      volumes: {
        // App-capture volume (webcam/upload) — read+write.
        frames: { policy: files.policy.allowAll() },
        // Drop volume the SDP pipeline writes to; the Pipeline page serves
        // raw frames via /api/files/inbox/raw.
        inbox: { policy: files.policy.publicRead() },
        // Read-only catalog of demo MP4s. Auto-mounted at
        //   GET /api/files/sample_videos/raw?path=<file>
        // which client/src/lib/samples.ts uses via sampleVideoUrl().
        sample_videos: { policy: files.policy.publicRead() },
        // Booth talk-track markdown + standalone HTML deck. The
        // auto-mounted /api/files/presenter_content/raw route refuses to
        // serve HTML inline (XSS protection) so the InfoPage actually hits
        // a dedicated /api/presenter-content/:id route below that sets
        // Content-Type explicitly. The volume is still declared here so
        // the .download() programmatic API works under the SP identity.
        presenter_content: { policy: files.policy.publicRead() },
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

      const ServingStatusParams = z.object({ alias: z.string().min(1) });
      const ServingStatusQuery = z.object({
        force: z.enum(["1", "true"]).optional().transform((v) => v != null),
      });
      app.get("/api/serving-status/:alias", asyncRoute(
        { params: ServingStatusParams, query: ServingStatusQuery },
        async ({ params, query }) => {
          try {
            return await getServingStatus(params.alias, { force: query.force });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new HttpError(502, `Serving status failed (${params.alias}): ${message}`);
          }
        },
      ));

      // ─── Sample videos ──────────────────────────────────────────────────
      //
      // One endpoint handles every flavor of demo video:
      //
      //   GET /api/sample-videos              -> JSON catalog (id -> url, etc).
      //   GET /api/sample-videos/:id          -> bytes, with the resolution
      //                                          chain below.
      //
      // The `:id` route resolves the bytes in this order, falling through on
      // miss until something serves:
      //
      //   1. `local` samples: client/public/sample-videos/<filename> on disk.
      //      Streamed via fs.createReadStream with HTTP Range support so the
      //      <video> element can seek. This is the dev-loop fast path - the
      //      MP4s ship with the repo (they're git-tracked) so a fresh clone
      //      can demo without any Databricks resources online.
      //   2. `local` samples that miss locally: fall back to the
      //      `sample_videos` UC volume via the AppKit files plugin's
      //      programmatic API (`.download()`, runs as the app SP). The bundle
      //      excludes the local MP4s from the app source upload (see
      //      databricks.yml -> sync.exclude) so deployed apps always take
      //      this path. No Range support here - the SDK download returns the
      //      full body - but browsers degrade gracefully.
      //   3. `upstream` samples (Roboflow CDN): proxied through this server
      //      so the canvas-tainting CORS problem goes away. Range headers
      //      are forwarded both ways so seek still works.
      //
      // Everything runs as the service principal; no OBO anywhere. The
      // upstream catalog lives in client/src/lib/samples.ts so the client
      // and server share one source of truth.

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

      // ─── Booth presenter content ─────────────────────────────────────
      //
      // The InfoPage in the UI renders two artifacts the booth presenter
      // edits independently of the rest of the app: the talk track
      // (markdown) and a standalone HTML deck. Both live in the
      // `presenter_content` UC volume so they can be refreshed by
      // re-running scripts/sync-presenter-content.sh - no app redeploy.
      //
      // Resolution order on each GET /api/presenter-content/:id:
      //   1. Local docs/<filename> on disk (dev inner loop).
      //   2. presenter_content volume via the files plugin (.download()).
      //   3. 404.
      //
      // Content-Type is set per-item from PRESENTER_CONTENT - in particular
      // the deck is served as text/html so the InfoPage iframe renders it
      // inline. The AppKit auto-mounted /raw route deliberately refuses
      // HTML for stored-XSS reasons, which is why this lives behind a
      // dedicated route.

      app.get("/api/presenter-content", (_req, res) => {
        res.json({
          items: Object.entries(PRESENTER_CONTENT).map(([id, def]) => ({
            id,
            filename: def.filename,
            contentType: def.contentType,
            label: def.label,
            url: `/api/presenter-content/${id}`,
          })),
        });
      });

      const IdParam = z.object({ id: z.string().min(1) });

      app.get("/api/presenter-content/:id", asyncRoute(
        { params: IdParam },
        async ({ params }, _req, res) => {
          const def = PRESENTER_CONTENT[params.id];
          if (!def) throw new HttpError(404, `Unknown presenter content id: ${params.id}`);
          if (await _streamLocalPresenterContent(def, res)) return;
          if (await _streamVolumePresenterContent(appkit.files("presenter_content"), def, res)) return;
          throw new HttpError(404, `${def.filename} not found locally or in the presenter_content volume.`);
        },
      ));

      // POST /api/talk-track/transform
      //
      // Rewrites the booth talk track (docs/dais-talk-track.md) for a
      // given speaker persona, audience persona, and target read time.
      // Sourced from the same presenter-content resolution chain as
      // GET /api/presenter-content/talk-track so the rewrite always
      // matches the markdown the page would otherwise render. The
      // foundation-model call goes through the `llm` serving alias, and
      // (sourceHash, persona tuple) results are cached by
      // server/talk-track-rewrite.ts so repeat requests inside an hour
      // are a Map lookup. The UI shows the original markdown by default
      // and only hits this route when the presenter clicks "Customize".
      const TalkTrackTransformBody = z.object({
        speakerPersona: z.string().trim().min(1).max(80),
        audiencePersona: z.string().trim().min(1).max(80),
        lengthMinutes: z.number().int().min(1).max(15),
      });

      app.post("/api/talk-track/transform", asyncRoute(
        { body: TalkTrackTransformBody },
        async ({ body }) => {
          const def = PRESENTER_CONTENT["talk-track"];
          const source = await _readPresenterContentText(
            def,
            appkit.files("presenter_content"),
          );
          if (!source) {
            throw new HttpError(
              404,
              `${def.filename} not found locally or in the presenter_content volume.`,
            );
          }
          return await rewriteTalkTrack(appkit, source, {
            speakerPersona: body.speakerPersona,
            audiencePersona: body.audiencePersona,
            lengthMinutes: body.lengthMinutes,
          });
        },
      ));

      app.get("/api/sample-videos/:id", asyncRoute(
        { params: IdParam },
        async ({ params }, req, res) => {
          const sample = getSampleVideo(params.id);
          if (!sample) throw new HttpError(404, `Unknown sample id: ${params.id}`);
          if (sample.local) {
            if (await _streamLocalSampleVideo(sample.local, req, res)) return;
            if (await _streamVolumeSampleVideo(appkit.files("sample_videos"), sample.local, res)) return;
            throw new HttpError(404, `Sample ${sample.id} not found locally or in the sample_videos volume.`);
          }
          if (sample.upstream) {
            await _proxyUpstreamSampleVideo(sample.upstream, req, res);
            return;
          }
          throw new HttpError(500, `Sample ${sample.id} is misconfigured (no local or upstream source).`);
        },
      ));

      const DetectBody = z.object({
        image: z.string().min(1),
        conf: z.number().default(0.35),
        iou: z.number().default(0.5),
        persist: z.boolean().default(false),
        model: z.string().default(DEFAULT_MODEL_ID),
      });

      // Models that resolve via the generic Claude vision detector instead
      // of a per-model Roboflow PyFunc. Models that share an identical
      // `labels` set share ONE Claude call per frame via the image-hash
      // cache, so listing both `spill` and `wet_floor_sign` with the same
      // label pair means the Spills page's parallel calls cost a single
      // round-trip. `match` is the Claude label whose hits this model
      // surfaces. `promptAddendum` lets us inject scene-specific guidance
      // without forking the detector.
      interface VisionGroup {
        labels: readonly string[];
        match: string;
        promptAddendum?: string;
      }
      const VISION_GROUPS: Record<string, VisionGroup> = {
        spill: { labels: ["spill", "cone"], match: "spill" },
        wet_floor_sign: { labels: ["spill", "cone"], match: "cone" },
      };

      function _toNormalizedDetections(hits: VisionDetection[], modelId: string): NormalizedDetection[] {
        return hits.map((h) => ({
          label: modelId,
          class_id: -1,
          confidence: h.confidence,
          bbox: h.bbox,
        }));
      }

      app.post("/api/detect", asyncRoute({ body: DetectBody }, async ({ body }) => {
        const model = getModel(body.model);
        if (!model) throw new HttpError(400, `Unknown model id: ${body.model}`);

        // Build the dataframe_records payload for the served PyFunc.
        // Every detector endpoint hosts exactly one model so there is no
        // dispatch column - the alias alone routes to the right endpoint.
        // `iou` is YOLO-only but the Roboflow + fog PyFuncs ignore unknown
        // row columns, so it's safe to send unconditionally.
        //
        // Models registered in VISION_GROUPS resolve via the generic
        // Claude vision detector. The NormalizedDetection contract on the
        // way out is unchanged so persist + overlay code stays the same.
        let detections: NormalizedDetection[] = [];
        try {
          const visionGroup = VISION_GROUPS[model.id];
          if (visionGroup) {
            const allHits = await detectWithClaude(appkit, body.image, {
              labels: visionGroup.labels,
              promptAddendum: visionGroup.promptAddendum,
            });
            const matched = allHits.filter(
              (h) => h.label === visionGroup.match && h.confidence >= body.conf,
            );
            detections = _toNormalizedDetections(matched, model.id);
          } else {
            const data = await invokeServing(appkit, model.servingAlias, {
              dataframe_records: [{ image: body.image, conf: body.conf, iou: body.iou }],
            });
            detections = _normalizeDatabricks(data);
          }
        } catch (err) {
          // EndpointNotDeployedError is handled by the global error
          // middleware (-> 503 envelope the UI branches on). Everything
          // else gets the existing "Detector failed (<id>): ..." shape.
          if (err instanceof Error && err.name === "EndpointNotDeployedError") throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new HttpError(502, `Detector failed (${model.id}): ${message}`);
        }

        let saved: { frame_id: string; url: string } | null = null;
        if (body.persist) {
          try {
            const buffer = decodeImage(body.image);
            if (!buffer) throw new Error("Could not decode base64 image.");
            const frameId = `frame_${Date.now()}`;
            const fileName = `${frameId}.jpg`;
            await appkit.files("frames").upload(fileName, buffer, { overwrite: true });

            // Insert one row per detection so the Detections page (driven by
            // /api/detections/stream and the recent-detections query) picks
            // them up immediately. The id column is BIGINT in the seed; we
            // derive distinct ids from `Date.now() + i` to avoid collisions
            // within a single capture.
            const baseId = Date.now();
            const storeId = STORE_IDS[Math.floor(Math.random() * STORE_IDS.length)];
            const ts = new Date().toISOString();
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
            // Persistence is best-effort - the user already got the
            // detections back; we just can't replay them later. Log so
            // the failure is visible without 5xx-ing the live response.
            console.warn("Persist failed:", err);
          }
        }

        return { detections, saved };
      }));

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

      // ─── Lakebase schema bootstrap ─────────────────────────────────────
      //
      // The app SP has `CAN_CONNECT_AND_CREATE` on the bound Lakebase
      // database (see resources/app.yml -> postgres) which lets it create
      // *new* schemas / extensions / tables but does NOT grant write access
      // to the built-in `public` schema, nor to any schema owned by another
      // role (Postgres 15+ default). So every table this app owns lives in
      // a dedicated schema created at runtime by the SP, which is implicitly
      // the schema's owner and therefore has full DDL/DML rights.
      //
      // Schema name follows the recommendation in the Cursor `databricks-apps`
      // skill's appkit/lakebase reference (the troubleshooting entry for
      // `permission denied for schema public` calls out `app_data`
      // specifically). Note that `databricks_postgres` is the default
      // *database* name in Lakebase Autoscaling, not a schema, and is what
      // PGDATABASE already resolves to.
      const APP_SCHEMA = "app_data";

      // Treat the duplicate-key races that `CREATE EXTENSION IF NOT EXISTS`
      // and `CREATE INDEX IF NOT EXISTS` can throw under concurrency as a
      // success. Postgres's internal catalog inserts (pg_type, pg_class,
      // pg_namespace) aren't synchronized against parallel "create if not
      // exists" callers, so two clients racing on extension/index install
      // surface as `duplicate key value violates unique constraint
      // "pg_type_typname_nsp_index"` / "pg_class_relname_nsp_index" /
      // "pg_namespace_nspname_index". Once the loser of the race retries
      // the read, the object exists, which is exactly the state we wanted.
      function _isCreateRace(err: unknown): boolean {
        const message = err instanceof Error ? err.message : String(err);
        return (
          message.includes("duplicate key value violates unique constraint")
          && (message.includes("pg_type_typname_nsp_index")
            || message.includes("pg_class_relname_nsp_index")
            || message.includes("pg_namespace_nspname_index")
            || message.includes("pg_extension_name_index"))
        );
      }

      // Bootstrap DDL is best-effort: any CREATE that fails (race with a
      // peer process, table/index already exists under a different owner
      // in local dev against an SP-owned schema, extension not installable
      // by this role, etc.) gets swallowed with a warn. If the object
      // genuinely isn't there, the downstream INSERT/SELECT will surface
      // a clear "relation does not exist" error of its own.
      async function _runIdempotentDdl(sql: string): Promise<void> {
        try {
          await appkit.lakebase.query(sql);
        } catch (err) {
          if (_isCreateRace(err)) return;
          const message = err instanceof Error ? err.message : String(err);
          const oneLine = sql.replace(/\s+/g, " ").trim().slice(0, 80);
          console.warn(`bootstrap DDL skipped (${message}): ${oneLine}`);
        }
      }

      const _ensureAppSchema = onceAsync(() =>
        _runIdempotentDdl(`CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA}`),
      );

      // Lakebase table backing the Guests page guest-count flush. Same
      // lazy ensure pattern as plate_reads / fog_observations / spill_cycles
      // below so a fresh Lakebase project works without any manual
      // migration.
      const _ensureGuestCountsTable = onceAsync(async () => {
        await _ensureAppSchema();
        await _runIdempotentDdl(`
          CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.guest_counts (
            id           BIGSERIAL PRIMARY KEY,
            ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_id    TEXT NOT NULL,
            zone         TEXT NOT NULL,
            person_count INT NOT NULL,
            store_id     TEXT
          )
        `);
        await _runIdempotentDdl(
          `CREATE INDEX IF NOT EXISTS idx_guest_counts_ts ON ${APP_SCHEMA}.guest_counts (ts DESC)`,
        );
      });

      // Guest-count persistence backed by Lakebase Postgres. The Guests page
      // posts batched zone counts here; the time-series chart reads recent
      // buckets back out.
      const GuestCountRow = z.object({
        source_id: z.string().min(1),
        zone: z.string().min(1),
        person_count: z.number().int().min(0),
        store_id: z.string().nullish(),
      });
      const GuestCountsBatch = z.object({
        batch: z.array(GuestCountRow).min(1).max(200),
      });

      app.post("/api/guest-counts", asyncRoute(
        { body: GuestCountsBatch },
        async ({ body }) => {
          await _ensureGuestCountsTable();
          const { sql: stmt, params } = buildBatchInsert(
            `${APP_SCHEMA}.guest_counts`,
            ["source_id", "zone", "person_count", "store_id"],
            body.batch,
          );
          const result = await appkit.lakebase.query(stmt, params);
          return { inserted: result.rowCount ?? 0 };
        },
      ));

      // License plate OCR. The Plates page sends a cropped image (typically
      // the bbox region returned by the YOLO vehicle detector). We forward
      // it to the llm endpoint as a Claude vision chat completion and
      // return both the extracted text and a tight plate bbox.
      //
      // Why this is a prompt-driven contract rather than `response_format`
      // + json_schema (Databricks structured outputs):
      //   1. AppKit's serving plugin filters request bodies against the
      //      typed `QueryEndpointInput` allowlist before invoking the
      //      endpoint. `response_format` isn't in that allowlist, so it
      //      gets silently stripped (`appkit:serving:schema-filter:
      //      Stripped unknown params from 'llm': response_format`) and
      //      the schema never reaches the model.
      //   2. `temperature` is on the typed allowlist but the Opus 4.7
      //      foundation model rejects it outright with
      //      "Model us.anthropic.claude-opus-4-7 does not support the
      //      temperature parameter".
      // So we go back to first principles: a tight prompt that names
      // the schema and shows one worked example. Claude follows the
      // example reliably enough that the plate bbox comes through on
      // the overwhelming majority of reads; when it doesn't, the
      // client falls back to the full OCR crop with no apology.
      const PlateOcrBody = z.object({ image: z.string().min(1) });
      app.post("/api/plate-ocr", asyncRoute({ body: PlateOcrBody }, async ({ body }) => {
        const dataUrl = toDataUrl(body.image);
        if (!dataUrl) throw new HttpError(400, "Invalid image payload (expected JPEG/PNG/WEBP base64 or data URL).");
        const prompt = [
          "You are a license plate OCR helper looking at a still image from a security camera.",
          "Two outputs are required: the alphanumeric plate text AND a tight rectangle around the plate. Both fields are mandatory whenever a plate is visible.",
          "Respond with a single line of minified JSON, no prose, no markdown fences, exactly matching this schema:",
          '{"plate":"<chars>","bbox":[x1,y1,x2,y2]}',
          "Field rules:",
          '  - "plate" is the alphanumeric plate text: uppercase, no spaces, no punctuation, no jurisdiction text or slogans.',
          '  - "bbox" is the location of the plate within the supplied image expressed as normalized fractions of the image width/height. Each value is a decimal between 0 and 1, with x1<x2 and y1<y2. (x1,y1) is the top-left corner, (x2,y2) is the bottom-right corner. License plates are usually a horizontal strip in the lower third of a rear-of-vehicle shot, so y values are typically > 0.4 and the strip is wider than it is tall.',
          'Example (a US plate "7ABC123" near the middle-bottom of a 4:3 image): {"plate":"7ABC123","bbox":[0.32,0.62,0.71,0.78]}',
          'If and only if no plate is visible at all, respond with: {"plate":"UNREADABLE","bbox":null}',
        ].join(" ");
        try {
          const data = await invokeServing(appkit, "llm", {
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
            // 160 tokens is plenty of headroom for the minified JSON
            // response plus its worked-example shape (~50-70 tokens
            // in practice). 80 was too tight - we occasionally lost
            // the closing brace and dropped the bbox.
            max_tokens: 160,
          });
          // Defensive parser: Claude sometimes wraps JSON in ```json fences
          // despite the prompt, and occasionally prepends a stray newline
          // or `Output:`. Strip those before JSON.parse so the bbox
          // survives the round trip.
          const raw = extractChatText(data).trim();
          const jsonText = extractJsonObject(raw);
          let plateText: string | null = null;
          let plateBbox: [number, number, number, number] | null = null;
          try {
            const parsed = JSON.parse(jsonText) as { plate?: unknown; bbox?: unknown };
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
            // Fall through with nulls; raw still goes back for debugging.
          }
          return {
            plate_text: plateText,
            plate_bbox: plateBbox,
            raw,
            model: process.env.DATABRICKS_SERVING_ENDPOINT_LLM ?? null,
          };
        } catch (err) {
          if (err instanceof Error && err.name === "EndpointNotDeployedError") throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new HttpError(500, `OCR call failed: ${message}`);
        }
      }));

      // Lakebase table backing the Plates page. The DDL lives here (rather
      // than a separate migration step) for the same reason fog_observations
      // and spill_cycles do - the app owns these tables and we want a fresh
      // workspace to come up clean without out-of-band SQL. The
      // ADD COLUMN IF NOT EXISTS rider is so older deployments (which
      // created the table without `plate_image`) pick up the new column
      // automatically on next boot.
      const _ensurePlateReadsTable = onceAsync(async () => {
        await _ensureAppSchema();
        await _runIdempotentDdl(`
          CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.plate_reads (
            id                   BIGSERIAL PRIMARY KEY,
            ts                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_id            TEXT NOT NULL,
            plate_text           TEXT NOT NULL,
            confidence           REAL NOT NULL,
            ocr_model            TEXT,
            detection_confidence REAL,
            plate_image          TEXT
          )
        `);
        // Add the column on existing deployments where the table predates
        // the image-capture feature. Postgres treats this as a no-op when
        // the column is already present.
        await _runIdempotentDdl(
          `ALTER TABLE ${APP_SCHEMA}.plate_reads ADD COLUMN IF NOT EXISTS plate_image TEXT`,
        );
        await _runIdempotentDdl(
          `CREATE INDEX IF NOT EXISTS idx_plate_reads_ts ON ${APP_SCHEMA}.plate_reads (ts DESC)`,
        );
      });

      // Persist a plate read from the client (after OCR). Separate from
      // /api/plate-ocr so the client can batch successful reads even if the
      // OCR happens at a different cadence than the persistence flush.
      // The `plate_image` field is the cropped plate region as a data URL
      // (or the full OCR crop when Claude didn't return a bbox) so the
      // Plates page and any downstream consumers can replay what the OCR
      // model actually saw.
      const PlateReadRow = z.object({
        source_id: z.string().min(1),
        plate_text: z.string().min(1).transform((s) => s.toUpperCase()),
        confidence: z.number().min(0),
        ocr_model: z.string().nullish(),
        detection_confidence: z.number().nullish(),
        plate_image: z.string().nullish().transform((v) => inlineBlob(v ?? null)),
      });
      const PlateReadsBatch = z.object({
        batch: z.array(PlateReadRow).min(1).max(100),
      });

      app.post("/api/plate-reads", asyncRoute(
        { body: PlateReadsBatch },
        async ({ body }) => {
          await _ensurePlateReadsTable();
          const { sql: stmt, params } = buildBatchInsert(
            `${APP_SCHEMA}.plate_reads`,
            ["source_id", "plate_text", "confidence", "ocr_model", "detection_confidence", "plate_image"],
            body.batch,
          );
          const result = await appkit.lakebase.query(stmt, params);
          return { inserted: result.rowCount ?? 0 };
        },
      ));

      const LimitQuery = z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      });

      type PlateReadRowOut = {
        id: number; ts: string; source_id: string; plate_text: string;
        confidence: number; ocr_model: string | null;
        detection_confidence: number | null; plate_image: string | null;
      };
      app.get("/api/plate-reads/recent", asyncRoute(
        { query: LimitQuery },
        async ({ query }) => {
          await _ensurePlateReadsTable();
          const r = await appkit.lakebase.query<PlateReadRowOut>(
            `SELECT id, ts, source_id, plate_text, confidence, ocr_model, detection_confidence, plate_image
               FROM ${APP_SCHEMA}.plate_reads ORDER BY ts DESC LIMIT $1`,
            [query.limit],
          );
          return { rows: r.rows };
        },
      ));

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
      const _ensureFogTable = onceAsync(async () => {
        await _ensureAppSchema();
        await _runIdempotentDdl(`
          CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.fog_observations (
            id           BIGSERIAL PRIMARY KEY,
            ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_id    TEXT NOT NULL,
            camera_label TEXT NOT NULL,
            fogged       BOOLEAN NOT NULL,
            region_count INT NOT NULL DEFAULT 0,
            area_pct     REAL NOT NULL DEFAULT 0
          )
        `);
        await _runIdempotentDdl(
          `CREATE INDEX IF NOT EXISTS idx_fog_observations_ts ON ${APP_SCHEMA}.fog_observations (ts DESC)`,
        );
        await _runIdempotentDdl(
          `CREATE INDEX IF NOT EXISTS idx_fog_observations_source_ts ON ${APP_SCHEMA}.fog_observations (source_id, ts DESC)`,
        );
      });

      const FogObsRow = z.object({
        source_id: z.string().min(1),
        camera_label: z.string().min(1),
        fogged: z.boolean(),
        region_count: z.number().int().min(0),
        area_pct: z.number().min(0).max(100),
      });
      const FogObsBatch = z.object({
        batch: z.array(FogObsRow).min(1).max(400),
      });

      app.post("/api/fog-observations", asyncRoute(
        { body: FogObsBatch },
        async ({ body }) => {
          await _ensureFogTable();
          const { sql: stmt, params } = buildBatchInsert(
            `${APP_SCHEMA}.fog_observations`,
            ["source_id", "camera_label", "fogged", "region_count", "area_pct"],
            body.batch,
          );
          const result = await appkit.lakebase.query(stmt, params);
          return { inserted: result.rowCount ?? 0 };
        },
      ));

      const FogRecentQuery = z.object({
        windowSec: z.coerce.number().int().min(60).max(86_400).default(600),
        bucketSec: z.coerce.number().int().min(5).max(3_600).default(30),
      });
      type FogBucketRow = {
        source_id: string; camera_label: string; bucket_ts: string;
        avg_area_pct: number; max_area_pct: number;
        fogged_ticks: number; total_ticks: number;
      };
      app.get("/api/fog-observations/recent", asyncRoute(
        { query: FogRecentQuery },
        async ({ query }) => {
          await _ensureFogTable();
          // Same bucketing pattern as guest_counts:
          // floor(ts / bucketSec) * bucketSec aligns buckets we can GROUP BY.
          // AVG over the bucket so the y-axis stays "% of frame fogged"
          // instead of "samples taken".
          const r = await appkit.lakebase.query<FogBucketRow>(`
            SELECT
              source_id,
              camera_label,
              to_timestamp(floor(extract(epoch FROM ts) / $1) * $1) AS bucket_ts,
              ROUND(AVG(area_pct)::numeric, 2)::float AS avg_area_pct,
              MAX(area_pct) AS max_area_pct,
              SUM(CASE WHEN fogged THEN 1 ELSE 0 END) AS fogged_ticks,
              COUNT(*) AS total_ticks
            FROM ${APP_SCHEMA}.fog_observations
            WHERE ts >= NOW() - ($2 || ' seconds')::interval
            GROUP BY source_id, camera_label, bucket_ts
            ORDER BY bucket_ts ASC, source_id ASC
          `, [query.bucketSec, String(query.windowSec)]);
          return { windowSec: query.windowSec, bucketSec: query.bucketSec, rows: r.rows };
        },
      ));

      // Most-recent rows where the camera was actually fogged, used by the
      // "Recent fog events" panel on the Camera Health page.
      const IncidentsQuery = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
      });
      type FogIncidentRow = {
        id: number; ts: string; source_id: string; camera_label: string;
        region_count: number; area_pct: number;
      };
      app.get("/api/fog-observations/incidents", asyncRoute(
        { query: IncidentsQuery },
        async ({ query }) => {
          await _ensureFogTable();
          const r = await appkit.lakebase.query<FogIncidentRow>(
            `SELECT id, ts, source_id, camera_label, region_count, area_pct
               FROM ${APP_SCHEMA}.fog_observations
               WHERE fogged = TRUE
               ORDER BY ts DESC
               LIMIT $1`,
            [query.limit],
          );
          return { rows: r.rows };
        },
      ));

      // ─── Spill -> cone response cycles ────────────────────────────────
      //
      // The Spills page (Spills.tsx) runs both `spill` and `wet_floor_sign`
      // detectors on the same looping aisle clip. A "cycle" = the wall-clock
      // delta between the first spill detection and the first cone
      // detection. The client POSTs one row per completed cycle here; the
      // summary endpoint exposes last + rolling avg so the page can render
      // the same "stat cards + recent list" treatment Plates / CameraHealth
      // already use.
      //
      // Table is created lazily on first POST so the demo works on a fresh
      // Lakebase project without any manual migration.
      const _ensureSpillCyclesTable = onceAsync(async () => {
        await _ensureAppSchema();
        await _runIdempotentDdl(`
          CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.spill_cycles (
            id              BIGSERIAL PRIMARY KEY,
            ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_id       TEXT NOT NULL,
            spill_first_ts  TIMESTAMPTZ NOT NULL,
            cone_first_ts   TIMESTAMPTZ NOT NULL,
            response_ms     INT NOT NULL,
            was_assisted    BOOLEAN NOT NULL DEFAULT FALSE
          )
        `);
        await _runIdempotentDdl(
          `CREATE INDEX IF NOT EXISTS idx_spill_cycles_ts ON ${APP_SCHEMA}.spill_cycles (ts DESC)`,
        );
      });

      const SpillCycleBody = z.object({
        source_id: z.string().min(1),
        spill_first_ts: z.string().min(1),
        cone_first_ts: z.string().min(1),
        response_ms: z.number().int().min(0),
        was_assisted: z.boolean().default(false),
      });

      app.post("/api/spill-cycles", asyncRoute(
        { body: SpillCycleBody },
        async ({ body }) => {
          await _ensureSpillCyclesTable();
          const r = await appkit.lakebase.query(
            `INSERT INTO ${APP_SCHEMA}.spill_cycles
               (source_id, spill_first_ts, cone_first_ts, response_ms, was_assisted)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [body.source_id, body.spill_first_ts, body.cone_first_ts, body.response_ms, body.was_assisted],
          );
          return { inserted: r.rowCount ?? 0 };
        },
      ));

      const SpillRecentQuery = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
      });
      type SpillRecentRow = {
        id: number; ts: string; source_id: string;
        spill_first_ts: string; cone_first_ts: string;
        response_ms: number; was_assisted: boolean;
      };
      app.get("/api/spill-cycles/recent", asyncRoute(
        { query: SpillRecentQuery },
        async ({ query }) => {
          await _ensureSpillCyclesTable();
          const r = await appkit.lakebase.query<SpillRecentRow>(
            `SELECT id, ts, source_id, spill_first_ts, cone_first_ts, response_ms, was_assisted
               FROM ${APP_SCHEMA}.spill_cycles
               ORDER BY ts DESC
               LIMIT $1`,
            [query.limit],
          );
          return { rows: r.rows };
        },
      ));

      type SpillSummaryRow = {
        cycles: number;
        avg_response_ms: number | null;
        min_response_ms: number | null;
        last_response_ms: number | null;
        last_ts: string | null;
      };
      app.get("/api/spill-cycles/summary", asyncRoute({}, async () => {
        await _ensureSpillCyclesTable();
        // Avg / min / fastest over the last 50 cycles so a single demo run
        // doesn't get drowned out by a backlog of slow historical cycles.
        // The MIN filter (>= 1000ms) drops cycles that finished
        // unrealistically fast - those are almost always the result of
        // the spill+cone landing in the SAME detection tick (the cycle
        // gets stamped with delta=0) or a stale persisted cycle from a
        // looped clip, neither of which should be advertised as the
        // operator's "fastest response" on the summary card.
        const r = await appkit.lakebase.query<SpillSummaryRow>(
          `WITH recent AS (
             SELECT response_ms, ts
             FROM ${APP_SCHEMA}.spill_cycles
             ORDER BY ts DESC
             LIMIT 50
           )
           SELECT
             COUNT(*)::int                                            AS cycles,
             ROUND(AVG(response_ms))::int                             AS avg_response_ms,
             MIN(response_ms) FILTER (WHERE response_ms >= 1000)::int AS min_response_ms,
             (SELECT response_ms FROM recent ORDER BY ts DESC LIMIT 1) AS last_response_ms,
             (SELECT ts FROM recent ORDER BY ts DESC LIMIT 1)          AS last_ts
           FROM recent`,
        );
        return r.rows[0] ?? {
          cycles: 0, avg_response_ms: null, min_response_ms: null,
          last_response_ms: null, last_ts: null,
        };
      }));

      // ─── Facial recognition ──────────────────────────────────────────
      //
      // The Facial Recognition page enrolls a small set of "known" faces
      // (banned / VIP / staff) and then runs the live webcam through the
      // lensiq-face-recognition endpoint per tick. Matching is a single
      // pgvector cosine search against the enrolled embeddings:
      //
      //   1. Per-frame: POST /api/face-match with the captured image.
      //      The endpoint detects faces + emits 512-d ArcFace embeddings;
      //      for each face we run `SELECT ... ORDER BY embedding <=>
      //      $face_emb LIMIT 1`. If similarity >= threshold the face is
      //      labelled with the known person's name + role and a row is
      //      inserted into `face_matches` (deduped by face id + 30s cool-
      //      down so a lingering subject doesn't spam the stream).
      //   2. One-shot enroll: POST /api/faces with a name + role + image
      //      crop calls the same endpoint, picks the largest detected
      //      face, and stores the embedding + thumbnail in postgres.
      //
      // Embeddings are stored as `vector(512)` (pgvector). HNSW index
      // on cosine ops so per-tick matches stay constant-time even with
      // a few hundred enrolled faces.
      const _ensureFacesTables = onceAsync(async () => {
        await _ensureAppSchema();
        // pgvector ships with Lakebase but is not enabled by default per
        // database; CREATE EXTENSION IF NOT EXISTS is idempotent and the
        // app SP has CAN_CONNECT_AND_CREATE so it's allowed to install
        // extensions on the bound database.
        await _runIdempotentDdl("CREATE EXTENSION IF NOT EXISTS vector");
        await _runIdempotentDdl(`
          CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.faces (
            id           BIGSERIAL PRIMARY KEY,
            name         TEXT NOT NULL,
            role         TEXT NOT NULL CHECK (role IN ('banned', 'vip', 'staff')),
            image        TEXT,
            embedding    vector(512) NOT NULL,
            det_score    REAL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        // HNSW cosine index for sub-millisecond matches. The 'vector_cosine_ops'
        // opclass matches the `<=>` operator we use in /api/face-match.
        await _runIdempotentDdl(`
          CREATE INDEX IF NOT EXISTS idx_faces_embedding
            ON ${APP_SCHEMA}.faces USING hnsw (embedding vector_cosine_ops)
        `);
        await _runIdempotentDdl(`
          CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.face_matches (
            id          BIGSERIAL PRIMARY KEY,
            ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source_id   TEXT NOT NULL,
            face_id     BIGINT REFERENCES ${APP_SCHEMA}.faces(id) ON DELETE SET NULL,
            name        TEXT NOT NULL,
            role        TEXT NOT NULL,
            similarity  REAL NOT NULL,
            bbox_x1     INT NOT NULL,
            bbox_y1     INT NOT NULL,
            bbox_x2     INT NOT NULL,
            bbox_y2     INT NOT NULL,
            frame_image TEXT
          )
        `);
        await _runIdempotentDdl(
          `CREATE INDEX IF NOT EXISTS idx_face_matches_ts ON ${APP_SCHEMA}.face_matches (ts DESC)`,
        );
      });

      // Shape of one face returned by lensiq-face-recognition. The PyFunc
      // returns one list per dataframe row; each entry is
      // `{bbox, det_score, embedding}` where embedding is a 512-float
      // ArcFace vector (already L2-normalized so cosine == dot).
      interface FaceFromEndpoint {
        bbox: [number, number, number, number];
        det_score: number;
        embedding: number[];
      }

      // pgvector accepts a `[v1,v2,...]` literal cast to ::vector. We do
      // the cast at the call site so the column type stays opaque to the
      // pg driver.
      function _toPgVector(emb: number[]): string {
        return "[" + emb.map((v) => Number(v).toString()).join(",") + "]";
      }

      function _extractFaces(raw: unknown): FaceFromEndpoint[] {
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
        if (Array.isArray(body)) items = body;
        else if (body && typeof body === "object") {
          const obj = body as Record<string, unknown>;
          if (Array.isArray(obj.predictions)) items = obj.predictions;
        }
        // PyFunc returns one list per row, so we get [[face, face], ...]
        // for a single-row request. Flatten to the first row.
        if (items.length > 0 && items.every((x) => Array.isArray(x))) {
          items = items.flat();
        }
        const out: FaceFromEndpoint[] = [];
        for (const c of items) {
          if (!c || typeof c !== "object") continue;
          const rec = c as Record<string, unknown>;
          const bbox = Array.isArray(rec.bbox) && rec.bbox.length === 4
            ? (rec.bbox.map((n) => Math.round(Number(n))) as [number, number, number, number])
            : null;
          const emb = Array.isArray(rec.embedding) ? rec.embedding.map((v) => Number(v)) : null;
          if (!bbox || !emb || emb.length === 0) continue;
          out.push({
            bbox,
            det_score: typeof rec.det_score === "number" ? rec.det_score : 0,
            embedding: emb,
          });
        }
        return out;
      }

      async function _embedFaces(image: string): Promise<FaceFromEndpoint[]> {
        // invokeServing throws EndpointNotDeployedError when the alias
        // points at an endpoint that hasn't been provisioned yet. The
        // /api/faces and /api/face-match routes funnel that through
        // sendEndpointError() so the client gets a structured 503 it
        // can branch on without regex-matching the error string.
        const data = await invokeServing(appkit, "face_recognition", {
          dataframe_records: [{ image }],
        });
        return _extractFaces(data);
      }

      // POST /api/faces
      //   Body: { name, role, image (b64 data URL or raw b64) }
      //   Detects faces in the image, picks the largest (closest to camera),
      //   stores the row, and returns the new face id + thumbnail. If no
      //   face is detected returns 422 so the client can surface a friendly
      //   "couldn't see a face in that photo" message.
      const FaceEnrollBody = z.object({
        name: z.string().trim().min(1),
        role: z.enum(["banned", "vip", "staff"]),
        image: z.string().min(1),
      });

      app.post("/api/faces", asyncRoute({ body: FaceEnrollBody }, async ({ body }) => {
        await _ensureFacesTables();
        const faces = await _embedFaces(body.image);
        if (faces.length === 0) {
          throw new HttpError(422, "No face detected in the uploaded image.");
        }
        // Pick the largest bbox (face closest to the camera) - works around
        // photos where a background bystander also got embedded.
        const primary = faces.reduce((best, f) => {
          const aBest = (best.bbox[2] - best.bbox[0]) * (best.bbox[3] - best.bbox[1]);
          const aCur = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]);
          return aCur > aBest ? f : best;
        });
        const insert = await appkit.lakebase.query<{ id: number; created_at: string }>(
          `INSERT INTO ${APP_SCHEMA}.faces (name, role, image, embedding, det_score)
             VALUES ($1, $2, $3, $4::vector, $5)
             RETURNING id, created_at`,
          [body.name, body.role, inlineBlob(body.image), _toPgVector(primary.embedding), primary.det_score],
        );
        return {
          id: insert.rows[0]?.id,
          name: body.name,
          role: body.role,
          created_at: insert.rows[0]?.created_at,
        };
      }));

      // GET /api/faces  -> list of enrolled faces (no embeddings - the
      // raw 512-float vector is just noise for the UI).
      type EnrolledFaceRow = {
        id: number; name: string; role: string; image: string | null;
        det_score: number | null; created_at: string;
      };
      app.get("/api/faces", asyncRoute({}, async () => {
        await _ensureFacesTables();
        const r = await appkit.lakebase.query<EnrolledFaceRow>(
          `SELECT id, name, role, image, det_score, created_at
             FROM ${APP_SCHEMA}.faces ORDER BY created_at DESC`,
        );
        return { faces: r.rows };
      }));

      const FaceIdParam = z.object({
        id: z.coerce.number().int().positive(),
      });
      app.delete("/api/faces/:id", asyncRoute(
        { params: FaceIdParam },
        async ({ params }) => {
          await _ensureFacesTables();
          const r = await appkit.lakebase.query(
            `DELETE FROM ${APP_SCHEMA}.faces WHERE id = $1`,
            [params.id],
          );
          return { deleted: r.rowCount ?? 0 };
        },
      ));

      // POST /api/face-match
      //   Body: { image (b64), source_id?, min_similarity? (default 0.45),
      //           persist? (default true) }
      //   Returns: { faces: [{bbox, det_score, match: {face_id, name, role,
      //                                                similarity} | null}] }
      //
      // When a face is matched above threshold AND persist=true, inserts a
      // face_matches row. Per-face dedup: we only insert a new row for a
      // given face_id once per FACE_MATCH_DEDUP_MS window so a subject
      // hanging in front of the camera doesn't fill the table.
      const FACE_MATCH_DEDUP_MS = 30_000;
      // Cosine similarity floor. ArcFace w600k_r50 lit reports
      // ~0.65 at the same-identity median, 0.30 at the impostor 99th
      // percentile. 0.45 keeps recall while staying clear of impostor
      // noise on a small enrolled population.
      const FACE_MATCH_DEFAULT_THRESHOLD = 0.45;
      // Per face_id -> last persisted ts. Process-local; that's fine for
      // the booth demo (single replica) and dedupes inside the user's
      // session. A second replica would just dedupe independently.
      const _faceMatchLastTs = new Map<number, number>();

      const FaceMatchBody = z.object({
        image: z.string().min(1),
        source_id: z.string().default("webcam"),
        min_similarity: z.number().default(FACE_MATCH_DEFAULT_THRESHOLD),
        persist: z.boolean().default(true),
      });

      type FaceMatchResult = {
        face_id: number; name: string; role: string;
        similarity: number; image: string | null;
      };

      app.post("/api/face-match", asyncRoute({ body: FaceMatchBody }, async ({ body }) => {
        const faces = await _embedFaces(body.image);

        // Table-init failures are tolerated here: the model already gave
        // us faces, so render bboxes-without-matches instead of 5xx-ing
        // the live tick. (In prod the SP owns the tables and this never
        // trips; in local dev OBO users can run DDL the SP already did.)
        let tableInitOk = true;
        let warning: string | undefined;
        try {
          await _ensureFacesTables();
        } catch (err) {
          tableInitOk = false;
          warning = err instanceof Error ? err.message : String(err);
        }

        const out: Array<{
          bbox: [number, number, number, number];
          det_score: number;
          match: FaceMatchResult | null;
        }> = [];

        for (const face of faces) {
          let match: FaceMatchResult | null = null;
          if (tableInitOk) {
            try {
              // 1 - cosine_distance = cosine_similarity. With L2-normalized
              // ArcFace embeddings this is just the dot product, but using
              // the `<=>` operator + HNSW index keeps performance constant
              // as the enrolled set grows.
              const r = await appkit.lakebase.query<{
                id: number; name: string; role: string;
                image: string | null; similarity: number;
              }>(
                `SELECT id, name, role, image,
                        1 - (embedding <=> $1::vector) AS similarity
                   FROM ${APP_SCHEMA}.faces
                   ORDER BY embedding <=> $1::vector
                   LIMIT 1`,
                [_toPgVector(face.embedding)],
              );
              const row = r.rows[0];
              if (row && row.similarity >= body.min_similarity) {
                match = {
                  face_id: row.id, name: row.name, role: row.role,
                  similarity: row.similarity, image: row.image,
                };
              }
            } catch (err) {
              // Per-face DB error - the bbox still renders.
              console.warn("face match query failed:", err);
            }
          }
          out.push({ bbox: face.bbox, det_score: face.det_score, match });

          if (match && body.persist) {
            const last = _faceMatchLastTs.get(match.face_id) ?? 0;
            const now = Date.now();
            if (now - last >= FACE_MATCH_DEDUP_MS) {
              _faceMatchLastTs.set(match.face_id, now);
              try {
                await appkit.lakebase.query(
                  `INSERT INTO ${APP_SCHEMA}.face_matches
                     (source_id, face_id, name, role, similarity,
                      bbox_x1, bbox_y1, bbox_x2, bbox_y2, frame_image)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [
                    body.source_id, match.face_id, match.name, match.role, match.similarity,
                    face.bbox[0], face.bbox[1], face.bbox[2], face.bbox[3], inlineBlob(body.image),
                  ],
                );
              } catch (err) {
                console.warn("face_matches insert failed:", err);
              }
            }
          }
        }

        return warning ? { faces: out, warning } : { faces: out };
      }));

      // GET /api/face-matches/recent?limit=50[&before_ts=<iso>&before_id=<n>]
      //
      // Keyset pagination on (ts DESC, id DESC). Pass the last row's `ts` and
      // `id` from a previous page in `before_ts` / `before_id` to fetch the
      // next older page. Without those params, returns the most recent
      // `limit` rows. The composite tuple comparison `(ts, id) < ($ts, $id)`
      // is stable across timestamp ties because BIGSERIAL `id` is unique.
      // Cursor pair must be specified together. `transform`s give a stable
      // shape downstream: ints for the id, ISO string for the ts, both
      // optional but tied to each other.
      const FaceMatchesRecentQuery = z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before_ts: z.string().min(1).optional(),
        before_id: z.coerce.number().int().optional(),
      }).refine(
        (q) => (q.before_ts == null) === (q.before_id == null),
        { message: "before_ts and before_id must be provided together" },
      );

      type FaceMatchRow = {
        id: number; ts: string; source_id: string; face_id: number | null;
        name: string; role: string; similarity: number;
        bbox_x1: number; bbox_y1: number; bbox_x2: number; bbox_y2: number;
        frame_image: string | null; enrolled_image: string | null;
      };

      app.get("/api/face-matches/recent", asyncRoute(
        { query: FaceMatchesRecentQuery },
        async ({ query }) => {
          await _ensureFacesTables();
          const useCursor = query.before_ts != null && query.before_id != null;
          const baseSelect = `SELECT m.id, m.ts, m.source_id, m.face_id, m.name, m.role, m.similarity,
                    m.bbox_x1, m.bbox_y1, m.bbox_x2, m.bbox_y2, m.frame_image,
                    f.image AS enrolled_image
             FROM ${APP_SCHEMA}.face_matches m
             LEFT JOIN ${APP_SCHEMA}.faces f ON f.id = m.face_id`;
          const sql = useCursor
            ? `${baseSelect}
               WHERE (m.ts, m.id) < ($2::timestamptz, $3)
               ORDER BY m.ts DESC, m.id DESC LIMIT $1`
            : `${baseSelect}
               ORDER BY m.ts DESC, m.id DESC LIMIT $1`;
          const params: Array<string | number> = useCursor
            ? [query.limit, query.before_ts!, query.before_id!]
            : [query.limit];
          const r = await appkit.lakebase.query<FaceMatchRow>(sql, params);
          return { rows: r.rows };
        },
      ));

      // GET /api/face-matches/stream  -> SSE of new face_matches rows.
      // Mirrors /api/detections/stream so the Facial Recognition page can
      // append to its "recent matches" list as they land.
      app.get("/api/face-matches/stream", async (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        try {
          await _ensureFacesTables();
        } catch (err) {
          // Soft-fail; we still want to keep the connection open so the
          // client doesn't tear down + reconnect in a loop.
          const message = err instanceof Error ? err.message : String(err);
          res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        }

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
            const r = await appkit.lakebase.query<{
              id: number; ts: string; source_id: string; face_id: number | null;
              name: string; role: string; similarity: number;
              bbox_x1: number; bbox_y1: number; bbox_x2: number; bbox_y2: number;
              frame_image: string | null; enrolled_image: string | null;
            }>(
              `SELECT m.id, m.ts, m.source_id, m.face_id, m.name, m.role, m.similarity,
                      m.bbox_x1, m.bbox_y1, m.bbox_x2, m.bbox_y2, m.frame_image,
                      f.image AS enrolled_image
               FROM ${APP_SCHEMA}.face_matches m
               LEFT JOIN ${APP_SCHEMA}.faces f ON f.id = m.face_id
               WHERE m.ts > $1::timestamptz
               ORDER BY m.ts ASC LIMIT 50`,
              [lastTs],
            );
            for (const row of r.rows) {
              writeEvent("match", row);
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

      // Same window/bucket schema shape as /api/fog-observations/recent.
      const BucketWindowQuery = z.object({
        windowSec: z.coerce.number().int().min(60).max(86_400).default(600),
        bucketSec: z.coerce.number().int().min(5).max(3_600).default(30),
      });
      type GuestBucketRow = {
        zone: string; bucket_ts: string;
        avg_count: number; max_count: number;
      };
      app.get("/api/guest-counts/recent", asyncRoute(
        { query: BucketWindowQuery },
        async ({ query }) => {
          await _ensureGuestCountsTable();
          // Bucket by truncating timestamps into floor(ts / bucketSec)
          // windows and average per-zone counts inside each bucket.
          // Averaging (vs summing) keeps the y-axis meaning "people
          // seen" instead of "samples taken" so the chart stays
          // interpretable when the client posts at variable cadence.
          const r = await appkit.lakebase.query<GuestBucketRow>(`
            SELECT
              zone,
              to_timestamp(floor(extract(epoch FROM ts) / $1) * $1) AS bucket_ts,
              ROUND(AVG(person_count)::numeric, 2)::float AS avg_count,
              MAX(person_count) AS max_count
            FROM ${APP_SCHEMA}.guest_counts
            WHERE ts >= NOW() - ($2 || ' seconds')::interval
            GROUP BY zone, bucket_ts
            ORDER BY bucket_ts ASC, zone ASC
          `, [query.bucketSec, String(query.windowSec)]);
          return { windowSec: query.windowSec, bucketSec: query.bucketSec, rows: r.rows };
        },
      ));

      // Centralized error middleware. Routes can throw - HttpError /
      // ZodError / EndpointNotDeployedError are turned into the right
      // status here so handlers don't have to.
      app.use(errorMiddleware);
    });
  },
});

export default AppKit;
