import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from "@databricks/appkit-ui/react";
import { Loader2, ScanLine, ZoomIn } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { formatRelative } from "../lib/format";
import { SAMPLE_VIDEOS, getSampleVideo } from "../lib/samples";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { useBatchFlush } from "../lib/useBatchFlush";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";

// JPEG quality for the plate crop we persist + render. The crop is
// always saved at native pixel resolution from the OCR-input canvas
// (no downscaling) - display sizing is purely CSS, so the bytes we
// write to postgres are the sharpest version we have. ~0.85 keeps the
// data URL under ~50KB per row for typical 300-400px-wide plate crops.
const PLATE_CROP_JPEG_QUALITY = 0.85;
// Max number of plate entries to keep in the in-page list. Newest at top.
const RECENT_PLATES_MAX = 20;

// Live License Plates view.
//
// The pipeline:
//   1. YOLO detects vehicles (car / truck / bus / motorcycle) in the feed.
//   2. A centroid tracker assigns each vehicle a track id so we only OCR a
//      given plate once - re-OCR'ing every tick would burn LLM tokens and
//      flood the UI.
//   3. When a NEW track appears, the vehicle's bbox is cropped from the
//      current video frame and POSTed to /api/plate-ocr, which forwards
//      the crop to Claude as a chat-completions image_url message and
//      extracts the alphanumeric plate text plus a normalized [0,1] bbox
//      around the plate within the crop.
//   4. The plate region is cropped to a small JPEG data URL and pushed
//      to the page's recent-reads list (deduped so a vehicle lingering
//      in frame doesn't spam consecutive entries).
//   5. Each accepted read is batched to /api/plate-reads -> Lakebase
//      Postgres, including the plate-image data URL so the postgres row
//      doubles as an audit log of exactly what the OCR pipeline saw.
//
// This avoids deploying a separate license-plate-detection model: Claude's
// vision capability finds the plate within the cropped vehicle region and
// reads it in one step. When a dedicated `license_plate` endpoint is
// available, swap the model in OCR_VEHICLE_LABELS for tighter bboxes.

const FEED_FPS = 1;
// Generous padding around the vehicle bbox - the plate often sits just
// outside YOLO's tight car/truck box (rear bumper, license tag mount), so
// expanding gives Claude the context it needs to localize and read the
// digits without the rest of the truck dominating the frame.
const OCR_PADDING_FRACTION = 0.18;
// OCR crop max width. Larger than the live detect frame because plate text
// is the entire game here - a 1024-wide crop gives the plate enough pixels
// for Claude vision to read confidently.
const OCR_CROP_MAX_WIDTH = 1024;
const POST_INTERVAL_MS = 5_000;
// Padding around the normalized plate bbox before we crop the saved
// image. Claude's plate bbox is tight on the alphanumerics; expanding
// gives the eye breathing room on the plate frame, mounting bracket,
// and (often) the state name above the digits, so the saved crop looks
// like a recognizable license plate rather than a floating row of
// letters. 0.18 buffers both axes by ~18% of the bbox dimensions.
const ZOOM_PADDING_FRACTION = 0.18;
const VEHICLE_LABELS = new Set(["car", "truck", "bus", "motorcycle"]);
const COLOR_VEHICLE = "#0ea5e9";
const COLOR_OCR_BAD = "#94a3b8";

interface PlatesPageProps {
  isActive: boolean;
}

// One readable plate event. `plateImage` is a small JPEG data URL cropped
// to just the plate region (or the full OCR crop when Claude didn't
// return a bbox). This is what we render in the recent-plates list AND
// what we persist to postgres on the next batch flush, so the row stores
// exactly what the human in the booth saw.
interface PlateRead {
  plateText: string;
  plateImage: string;
  capturedAt: number;
  sourceId: string;
}

interface VehicleTrack {
  id: number;
  centerX: number;
  centerY: number;
  bbox: [number, number, number, number];
  // When OCR succeeds Claude also returns a tight bbox around the plate
  // (in video pixel coords). The canvas overlay prefers this when present
  // so the box hugs the plate instead of the whole vehicle.
  plateBbox: [number, number, number, number] | null;
  lastSeenTick: number;
  plateText: string | null;
  ocrStatus: "pending" | "ok" | "unreadable" | "error";
  ocrAttempts: number;
}

interface PendingRead {
  source_id: string;
  plate_text: string;
  confidence: number;
  ocr_model: string | null;
  detection_confidence: number | null;
  plate_image: string | null;
}

const TRACK_TTL_TICKS = 4;
const MATCH_FRACTION = 0.18;

export function PlatesPage({ isActive }: PlatesPageProps) {
  const [sourceId, setSourceId] = useState("plates-daytime");
  const [sessionReads, setSessionReads] = useState<Array<{ plate: string; ts: number; source: string }>>([]);
  const [vehicleTracks, setVehicleTracks] = useState<VehicleTrack[]>([]);
  // Ongoing list of readable plates, newest at the top. We dedupe
  // consecutive same-text reads (e.g. a vehicle lingers in frame across
  // several OCR attempts and we keep getting the same plate back) so the
  // list reads as a chronological event log rather than spam.
  const [recentPlates, setRecentPlates] = useState<PlateRead[]>([]);

  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter((s) => s.models.includes("license_plate") || s.id === "plates-daytime"),
    [],
  );

  const pendingRef = useBatchFlush<PendingRead>({
    isActive,
    endpoint: "/api/plate-reads",
    intervalMs: POST_INTERVAL_MS,
  });
  // Mirror of the most recent plate text we've already accepted, used by
  // the OCR callback to dedupe. We can't read recentPlates state directly
  // inside useCallback because the closure captures a stale snapshot.
  const lastAcceptedPlateRef = useRef<string | null>(null);
  const handleReadDone = useCallback((read: {
    source_id: string;
    plate_text: string;
    confidence: number;
    ocr_model: string | null;
    detection_confidence: number | null;
    plate_image: string;
  }) => {
    // Skip if this is a repeat of the most recent plate. The booth
    // presenter watches the list grow - we don't want five identical
    // entries when a single vehicle lingers across ticks. Persistence to
    // postgres uses the same dedupe so the table mirrors what the user
    // sees.
    if (lastAcceptedPlateRef.current === read.plate_text) return;
    lastAcceptedPlateRef.current = read.plate_text;
    const entry: PlateRead = {
      plateText: read.plate_text,
      plateImage: read.plate_image,
      capturedAt: Date.now(),
      sourceId: read.source_id,
    };
    setRecentPlates((prev) => [entry, ...prev].slice(0, RECENT_PLATES_MAX));
    pendingRef.current.push({
      source_id: read.source_id,
      plate_text: read.plate_text,
      confidence: read.confidence,
      ocr_model: read.ocr_model,
      detection_confidence: read.detection_confidence,
      plate_image: read.plate_image,
    });
    setSessionReads((prev) => [{ plate: read.plate_text, ts: Date.now(), source: read.source_id }, ...prev].slice(0, 100));
  }, []);

  // Seed the recent-reads list from postgres on first mount so the user
  // walks into a populated list rather than waiting for the first live
  // detection. Rows without a `plate_image` (legacy data inserted before
  // the image column existed) are filtered out - they'd render as broken
  // tiles in the list and don't tell us anything the text alone can't.
  //
  // We only seed when the current list is still empty; if a live OCR
  // happens to fire before the fetch returns (rare - the seed is fast)
  // those entries win and the seed is discarded so we don't clobber
  // fresher live state.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/plate-reads/recent?limit=${RECENT_PLATES_MAX}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ rows: Array<{ ts: string; source_id: string; plate_text: string; plate_image: string | null }> }>;
      })
      .then(({ rows }) => {
        if (cancelled) return;
        const seeded: PlateRead[] = rows
          .filter((r) => typeof r.plate_image === "string" && r.plate_image.length > 0)
          .map((r) => ({
            plateText: r.plate_text,
            plateImage: r.plate_image as string,
            capturedAt: new Date(r.ts).getTime(),
            sourceId: r.source_id,
          }));
        if (seeded.length === 0) return;
        setRecentPlates((prev) => (prev.length === 0 ? seeded : prev));
        // Prime the dedupe ref against the newest seeded plate so a
        // live OCR call that happens to return that same plate next
        // doesn't double-write it to postgres.
        if (lastAcceptedPlateRef.current === null) {
          lastAcceptedPlateRef.current = seeded[0].plateText;
        }
      })
      .catch(() => {
        // Best-effort seed - if postgres is unreachable we just start
        // with an empty list and let the live pipeline fill it.
      });
    return () => { cancelled = true; };
  }, []);


  const sessionStats = useMemo(() => {
    const unique = new Set(sessionReads.map((r) => r.plate));
    return { reads: sessionReads.length, unique: unique.size };
  }, [sessionReads]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Plates read</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{sessionStats.reads}</span>
              <span className="text-xs text-slate-500">this session</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Unique plates</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{sessionStats.unique}</span>
              <span className="text-xs text-slate-500">this session</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Vehicles on camera</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums" style={{ color: COLOR_VEHICLE }}>{vehicleTracks.length}</span>
              <span className="text-xs text-slate-500">right now</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PlateFeed
            isActive={isActive}
            sourceId={sourceId}
            candidates={candidates}
            onSourceChange={setSourceId}
            onReadDone={handleReadDone}
            onTracksChange={setVehicleTracks}
          />
        </div>

        <RecentPlatesCard plates={recentPlates} />
      </div>
    </div>
  );
}

interface RecentPlatesCardProps {
  plates: PlateRead[];
}

// Right-hand recent-reads panel. Newest plate sits at the top with the
// zoomed plate image (pre-cropped server-side by the OCR pipeline) and
// the alphanumeric text. Consecutive duplicate reads are filtered
// upstream in `handleReadDone` so this list stays clean.
function RecentPlatesCard({ plates }: RecentPlatesCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ZoomIn className="w-4 h-4" />
          Recent license plate detections
        </CardTitle>
        <CardDescription>
          Newest at the top. Updates live as cars arrive.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {plates.length === 0 ? (
          <div className="text-sm text-slate-500 py-8 text-center">
            Waiting for the first plate read...
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 max-h-[640px] overflow-y-auto">
            {plates.map((p, idx) => (
              <li
                key={`${p.capturedAt}-${p.plateText}`}
                className="flex items-center gap-3 p-3"
              >
                <div
                  className="bg-black rounded-md overflow-hidden flex items-center justify-center shrink-0"
                  // Hero treatment for the newest plate so the booth
                  // visitor's eye lands on the most recent read.
                  style={{
                    width: idx === 0 ? 180 : 120,
                    height: idx === 0 ? 90 : 60,
                  }}
                >
                  <img
                    src={p.plateImage}
                    alt={`Plate ${p.plateText}`}
                    // Native-resolution JPEG bytes from postgres / the
                    // OCR pipeline. Sizing is purely CSS - the container
                    // sets a fixed display box, object-contain preserves
                    // the plate's aspect ratio inside that box, and
                    // imageRendering:pixelated keeps the alphanumerics
                    // crisp when the display box is larger than the
                    // native crop pixels.
                    className="w-full h-full object-contain"
                    style={{ imageRendering: "pixelated" }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`font-mono font-semibold tracking-wider text-slate-900 break-all ${
                      idx === 0 ? "text-2xl" : "text-lg"
                    }`}
                  >
                    {p.plateText}
                  </div>
                  <div className="text-xs text-slate-500 tabular-nums mt-0.5">
                    {formatRelative(new Date(p.capturedAt).toISOString())}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface PlateFeedProps {
  isActive: boolean;
  sourceId: string;
  candidates: typeof SAMPLE_VIDEOS;
  onSourceChange: (id: string) => void;
  onReadDone: (read: {
    source_id: string;
    plate_text: string;
    confidence: number;
    ocr_model: string | null;
    detection_confidence: number | null;
    plate_image: string;
  }) => void;
  onTracksChange: (tracks: VehicleTrack[]) => void;
}

function PlateFeed({ isActive, sourceId, candidates, onSourceChange, onReadDone, onTracksChange }: PlateFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inFlightRef = useRef(false);
  const tracksRef = useRef<VehicleTrack[]>([]);
  const tickIdxRef = useRef(0);
  const nextTrackIdRef = useRef(1);
  const [detections, setDetections] = useState<Detection[]>([]);
  // Detector-side status (rolling). Video lifecycle is owned by the
  // shared hook; we surface whichever message is more recent.
  const [detectorStatus, setDetectorStatus] = useState<string>("");

  const sample = useMemo(() => getSampleVideo(sourceId) ?? null, [sourceId]);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
  });

  useEffect(() => {
    tracksRef.current = [];
    tickIdxRef.current = 0;
    nextTrackIdRef.current = 1;
  }, [sourceId]);

  useEffect(() => {
    if (!isActive) return;
    const tick = async () => {
      const video = videoRef.current;
      if (inFlightRef.current || !video) return;
      const frame = captureVideoFrameForDetection(video);
      if (!frame) return;
      inFlightRef.current = true;
      const tickIdx = ++tickIdxRef.current;
      try {
        const result = await callDetector(frame.image, { model: "yolo" });
        const vehicles = result.detections
          .filter((d) => VEHICLE_LABELS.has(d.label))
          .map((d) => ({ ...d, bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY) }));
        setDetections(vehicles);

        const threshold = MATCH_FRACTION * Math.max(video.videoWidth || 1280, video.videoHeight || 720);
        const claimed = new Set<number>();
        const newTracks: VehicleTrack[] = [];
        for (const det of vehicles) {
          const [x1, y1, x2, y2] = det.bbox;
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          let best: VehicleTrack | null = null;
          let bestDist = Infinity;
          for (const t of tracksRef.current) {
            if (claimed.has(t.id)) continue;
            const dx = t.centerX - cx;
            const dy = t.centerY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < threshold && dist < bestDist) { best = t; bestDist = dist; }
          }
          if (best) {
            best.bbox = det.bbox;
            best.centerX = cx;
            best.centerY = cy;
            best.lastSeenTick = tickIdx;
            claimed.add(best.id);
          } else {
            const t: VehicleTrack = {
              id: nextTrackIdRef.current++,
              bbox: det.bbox,
              plateBbox: null,
              centerX: cx,
              centerY: cy,
              lastSeenTick: tickIdx,
              plateText: null,
              ocrStatus: "pending",
              ocrAttempts: 0,
            };
            tracksRef.current.push(t);
            newTracks.push(t);
            // Kick OCR off without blocking the tick - matches the existing
            // pattern where /api/detect is the long pole and we want the
            // overlay to keep up.
            void _runOcrForTrack(video, t, sourceId, det.confidence, onReadDone, () => setDetections((prev) => [...prev]));
          }
        }

        tracksRef.current = tracksRef.current.filter((t) => tickIdx - t.lastSeenTick <= TRACK_TTL_TICKS);
        onTracksChange([...tracksRef.current]);
        setDetectorStatus(vehicles.length > 0 ? `${vehicles.length} vehicle(s) in frame${newTracks.length > 0 ? ` - reading ${newTracks.length} new plate(s)` : ""}` : "Watching for vehicles...");
      } catch (err) {
        setDetectorStatus(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
      }
    };
    const id = setInterval(tick, 1000 / FEED_FPS);
    return () => clearInterval(id);
  }, [isActive, sourceId, onReadDone, onTracksChange]);

  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => {
        // Match this detection to a track so we can pull its OCR result
        // and (if available) the tight plate bbox Claude returned.
        const cx = (d.bbox[0] + d.bbox[2]) / 2;
        const cy = (d.bbox[1] + d.bbox[3]) / 2;
        let match: VehicleTrack | undefined;
        for (const t of tracksRef.current) {
          if (Math.abs(t.centerX - cx) < 8 && Math.abs(t.centerY - cy) < 8) { match = t; break; }
        }
        const plate = match?.plateText ?? null;
        // Prefer the tight plate bbox once OCR has returned it; otherwise
        // fall back to the vehicle bbox so the user still sees a hint of
        // where the read is being attempted.
        const bbox = (match?.plateBbox ?? d.bbox) as [number, number, number, number];
        const color = plate ? COLOR_VEHICLE : COLOR_OCR_BAD;
        const label = plate
          ? plate
          : match?.ocrStatus === "pending"
          ? "reading..."
          : match?.ocrStatus === "unreadable"
          ? "unreadable"
          : d.label;
        return { bbox, color, label, fillAlpha: 0, labelAlpha: 1 };
      }),
    [detections],
  );

  useEffect(() => {
    drawBboxOverlay(canvasRef.current, videoRef.current, videoSize, overlayBoxes);
  }, [overlayBoxes, videoSize]);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="plates-source">Source</Label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id="plates-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Plate-readable clips</SelectLabel>
                {candidates.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            loop
            className="absolute inset-0 w-full h-full object-contain"
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />
          <Badge
            variant="outline"
            className="absolute top-2 left-2 gap-1.5 backdrop-blur bg-white/85"
            style={{ borderColor: COLOR_VEHICLE, color: COLOR_VEHICLE }}
          >
            <ScanLine className="w-3 h-3" />
            Reading license plates
          </Badge>
        </div>
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          {videoStatus.kind === "loading" || detectorStatus.includes("reading") ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {videoStatus.kind === "loading"
            ? videoStatus.message
            : videoStatus.kind === "error"
            ? videoStatus.message
            : detectorStatus || "Initializing..."}
        </div>
      </CardContent>
    </Card>
  );
}

// Crop the vehicle bbox out of the current video frame, JPEG-encode it,
// POST to /api/plate-ocr (which calls Claude vision), and stamp the result
// on the track. We give the track a tiny bit of padding around the bbox so
// the plate isn't clipped by a tight detection.
async function _runOcrForTrack(
  video: HTMLVideoElement,
  track: VehicleTrack,
  sourceId: string,
  detectionConfidence: number,
  onReadDone: (read: {
    source_id: string;
    plate_text: string;
    confidence: number;
    ocr_model: string | null;
    detection_confidence: number | null;
    plate_image: string;
  }) => void,
  notify: () => void,
) {
  track.ocrAttempts += 1;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) {
    track.ocrStatus = "error";
    notify();
    return;
  }
  const [x1, y1, x2, y2] = track.bbox;
  const padX = (x2 - x1) * OCR_PADDING_FRACTION;
  const padY = (y2 - y1) * OCR_PADDING_FRACTION;
  const cx1 = Math.max(0, Math.floor(x1 - padX));
  const cy1 = Math.max(0, Math.floor(y1 - padY));
  const cx2 = Math.min(w, Math.ceil(x2 + padX));
  const cy2 = Math.min(h, Math.ceil(y2 + padY));
  const cw = cx2 - cx1;
  const ch = cy2 - cy1;
  if (cw <= 0 || ch <= 0) {
    track.ocrStatus = "error";
    notify();
    return;
  }
  const canvas = document.createElement("canvas");
  // Scale the crop so the wider edge sits at OCR_CROP_MAX_WIDTH. We
  // upscale small bboxes (rare) and downscale only when the source clip is
  // larger than 1024px wide, which keeps plate text legible.
  const scale = OCR_CROP_MAX_WIDTH / cw;
  canvas.width = Math.max(64, Math.round(cw * scale));
  canvas.height = Math.max(32, Math.round(ch * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    track.ocrStatus = "error";
    notify();
    return;
  }
  ctx.drawImage(video, cx1, cy1, cw, ch, 0, 0, canvas.width, canvas.height);
  const image = canvas.toDataURL("image/jpeg", 0.85);
  try {
    const res = await fetch("/api/plate-ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) {
      track.ocrStatus = "error";
      notify();
      return;
    }
    const body = (await res.json()) as {
      plate_text: string | null;
      plate_bbox: [number, number, number, number] | null;
      raw?: string;
      model?: string | null;
    };
    if (body.plate_text) {
      track.plateText = body.plate_text;
      track.ocrStatus = "ok";
      if (body.plate_bbox) {
        // Claude returns the plate location as normalized [0,1] coordinates
        // within the cropped image we sent. Map them back into the original
        // video coordinate space so the canvas overlay aligns with the
        // running video.
        const [nx1, ny1, nx2, ny2] = body.plate_bbox;
        const cw = cx2 - cx1;
        const ch = cy2 - cy1;
        track.plateBbox = [
          Math.round(cx1 + nx1 * cw),
          Math.round(cy1 + ny1 * ch),
          Math.round(cx1 + nx2 * cw),
          Math.round(cy1 + ny2 * ch),
        ];
      }
      // Build a small data URL of just the plate region. This is what the
      // UI shows in the recent-reads list AND what we persist alongside
      // the OCR text - one image per stored row so the postgres table is
      // a self-contained audit log of what the model actually saw.
      const plateImage = await _cropPlateImage(canvas, body.plate_bbox);
      onReadDone({
        source_id: sourceId,
        plate_text: body.plate_text,
        // We don't have a separate OCR confidence yet (Claude doesn't expose
        // one). Use the detection confidence as a proxy so the column has
        // signal even before we add a dedicated rerank pass.
        confidence: detectionConfidence,
        ocr_model: body.model ?? null,
        detection_confidence: detectionConfidence,
        plate_image: plateImage,
      });
    } else {
      track.ocrStatus = "unreadable";
    }
  } catch {
    track.ocrStatus = "error";
  } finally {
    notify();
  }
}

// Crop the plate region out of the OCR-input canvas at native pixel
// resolution. We deliberately do NOT downscale here - the source
// canvas is already capped by OCR_CROP_MAX_WIDTH on the vehicle crop,
// and within that the plate is only ~200-400px wide. Writing the
// native bytes keeps the saved image as sharp as the OCR pipeline
// ever saw, and all display sizing (recent-reads list, future detail
// views) is handled in CSS with `object-fit` + `imageRendering:
// pixelated` so the same bytes serve any container size.
//
// When Claude didn't return a plate bbox we fall back to the full
// OCR crop - heavier, but still useful as an audit log entry.
async function _cropPlateImage(
  sourceCanvas: HTMLCanvasElement,
  plateBbox: [number, number, number, number] | null,
): Promise<string> {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  let sx = 0, sy = 0, cropW = sw, cropH = sh;
  if (plateBbox) {
    const [nx1, ny1, nx2, ny2] = plateBbox;
    const bw = Math.max(0, nx2 - nx1);
    const bh = Math.max(0, ny2 - ny1);
    const padX = bw * ZOOM_PADDING_FRACTION;
    const padY = bh * ZOOM_PADDING_FRACTION;
    sx = Math.max(0, Math.floor((nx1 - padX) * sw));
    sy = Math.max(0, Math.floor((ny1 - padY) * sh));
    const ex = Math.min(1, nx2 + padX);
    const ey = Math.min(1, ny2 + padY);
    cropW = Math.max(1, Math.ceil(ex * sw) - sx);
    cropH = Math.max(1, Math.ceil(ey * sh) - sy);
  }
  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  const ctx = out.getContext("2d");
  if (!ctx) {
    // Worst case: hand back the whole source canvas. Heavier but still
    // a usable audit-log entry, and we never want a crop failure to
    // drop the read entirely.
    return sourceCanvas.toDataURL("image/jpeg", PLATE_CROP_JPEG_QUALITY);
  }
  // No scaling - source-rect dimensions equal destination-rect
  // dimensions, so we get a pixel-perfect copy of the plate region.
  ctx.drawImage(sourceCanvas, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
  return out.toDataURL("image/jpeg", PLATE_CROP_JPEG_QUALITY);
}

