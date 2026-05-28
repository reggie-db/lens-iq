import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from "@databricks/appkit-ui/react";
import { Car, Loader2, ScanLine } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { SAMPLE_VIDEOS, getSampleVideo, sampleVideoUrl } from "../lib/samples";

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
//      extracts the alphanumeric plate text.
//   4. Successful reads are batched to /api/plate-reads -> Lakebase Postgres
//      and rendered in the "Recent plates" panel.
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
const RECENT_REFRESH_MS = 5_000;
const RECENT_LIMIT = 30;
const VEHICLE_LABELS = new Set(["car", "truck", "bus", "motorcycle"]);
const COLOR_VEHICLE = "#0ea5e9";
const COLOR_OCR_BAD = "#94a3b8";

interface PlatesPageProps {
  isActive: boolean;
}

interface RecentRead {
  id: number;
  ts: string;
  source_id: string;
  plate_text: string;
  confidence: number;
  ocr_model: string | null;
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
}

const TRACK_TTL_TICKS = 4;
const MATCH_FRACTION = 0.18;

export function PlatesPage({ isActive }: PlatesPageProps) {
  const [sourceId, setSourceId] = useState("plates-daytime");
  const [recent, setRecent] = useState<RecentRead[]>([]);
  const [sessionReads, setSessionReads] = useState<Array<{ plate: string; ts: number; source: string }>>([]);
  const [vehicleTracks, setVehicleTracks] = useState<VehicleTrack[]>([]);

  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter((s) => s.models.includes("license_plate") || s.id === "plates-daytime"),
    [],
  );

  const pendingRef = useRef<PendingRead[]>([]);
  const handleReadDone = useCallback((read: { source_id: string; plate_text: string; confidence: number; ocr_model: string | null; detection_confidence: number | null }) => {
    pendingRef.current.push(read);
    setSessionReads((prev) => [{ plate: read.plate_text, ts: Date.now(), source: read.source_id }, ...prev].slice(0, 100));
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const flush = async () => {
      const batch = pendingRef.current.splice(0, pendingRef.current.length);
      if (batch.length === 0) return;
      try {
        const res = await fetch("/api/plate-reads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch }),
        });
        if (!res.ok) pendingRef.current.unshift(...batch);
      } catch {
        pendingRef.current.unshift(...batch);
      }
    };
    const id = setInterval(flush, POST_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isActive]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch(`/api/plate-reads/recent?limit=${RECENT_LIMIT}`);
      if (!res.ok) return;
      const body = (await res.json()) as { rows: RecentRead[] };
      setRecent(body.rows);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void loadRecent();
    const id = setInterval(() => void loadRecent(), RECENT_REFRESH_MS);
    return () => clearInterval(id);
  }, [isActive, loadRecent]);

  const sessionStats = useMemo(() => {
    const unique = new Set(sessionReads.map((r) => r.plate));
    return { reads: sessionReads.length, unique: unique.size };
  }, [sessionReads]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6 pb-4">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Plates read (session)</div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-semibold tabular-nums text-slate-900">{sessionStats.reads}</span>
              <span className="text-sm text-slate-500">successful OCR calls</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 pb-4">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Unique plates</div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-semibold tabular-nums text-slate-900">{sessionStats.unique}</span>
              <span className="text-sm text-slate-500">distinct readings</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 pb-4">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Vehicles tracked now</div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-semibold tabular-nums" style={{ color: COLOR_VEHICLE }}>{vehicleTracks.length}</span>
              <span className="text-sm text-slate-500">in current frame</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent plates</CardTitle>
            <CardDescription>Latest reads from Lakebase, refreshed every {Math.round(RECENT_REFRESH_MS / 1000)}s.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[460px] overflow-y-auto">
              {recent.length === 0 ? (
                <div className="text-sm text-slate-500">No plates read yet.</div>
              ) : (
                recent.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-slate-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <Car className="w-4 h-4 text-slate-500 shrink-0" />
                      <span className="font-mono text-sm font-semibold text-slate-900 truncate">{r.plate_text}</span>
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums shrink-0">
                      {_formatRelative(r.ts)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface PlateFeedProps {
  isActive: boolean;
  sourceId: string;
  candidates: typeof SAMPLE_VIDEOS;
  onSourceChange: (id: string) => void;
  onReadDone: (read: { source_id: string; plate_text: string; confidence: number; ocr_model: string | null; detection_confidence: number | null }) => void;
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
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState<string>("");

  const sample = useMemo(() => getSampleVideo(sourceId), [sourceId]);

  useEffect(() => {
    tracksRef.current = [];
    tickIdxRef.current = 0;
    nextTrackIdRef.current = 1;
  }, [sourceId]);

  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video || !sample) return;
    video.crossOrigin = "anonymous";
    video.loop = true;
    video.muted = true;
    video.src = sampleVideoUrl(sample);
    setStatus("Loading clip...");
    void video.play().catch(() => undefined);

    const syncVideoSize = () => {
      setVideoSize({ w: video.videoWidth || 0, h: video.videoHeight || 0 });
    };
    video.addEventListener("loadedmetadata", syncVideoSize);
    video.addEventListener("resize", syncVideoSize);
    return () => {
      video.removeEventListener("loadedmetadata", syncVideoSize);
      video.removeEventListener("resize", syncVideoSize);
      video.removeAttribute("src");
      video.load();
    };
  }, [isActive, sample]);

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
        setStatus(vehicles.length > 0 ? `${vehicles.length} vehicle(s) in frame${newTracks.length > 0 ? ` - OCRing ${newTracks.length} new` : ""}` : "Watching for vehicles...");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
      }
    };
    const id = setInterval(tick, 1000 / FEED_FPS);
    return () => clearInterval(id);
  }, [isActive, sourceId, onReadDone, onTracksChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const w = videoSize.w || video.videoWidth || 1280;
    const h = videoSize.h || video.videoHeight || 720;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (detections.length === 0) return;
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
    const fontSize = Math.max(14, Math.round(canvas.width / 60));
    ctx.font = `${fontSize}px sans-serif`;
    for (const d of detections) {
      // Match this detection to a track so we can pull its OCR result and
      // (if available) the tight plate bbox Claude returned.
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
      const [x1, y1, x2, y2] = match?.plateBbox ?? d.bbox;
      const color = plate ? COLOR_VEHICLE : COLOR_OCR_BAD;
      ctx.strokeStyle = color;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = plate
        ? plate
        : match?.ocrStatus === "pending"
        ? "reading..."
        : match?.ocrStatus === "unreadable"
        ? "unreadable"
        : d.label;
      const padding = 6;
      const labelHeight = Math.max(20, Math.round(canvas.width / 45));
      const tw = ctx.measureText(label).width + padding * 2;
      ctx.fillStyle = color;
      ctx.fillRect(x1, Math.max(0, y1 - labelHeight), tw, labelHeight);
      ctx.fillStyle = "white";
      ctx.fillText(label, x1 + padding, Math.max(labelHeight - padding, y1 - padding));
    }
  }, [detections, videoSize]);

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
            License plate OCR
          </Badge>
        </div>
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          {status.includes("reading") || status.includes("OCRing") ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {status || "Initializing..."}
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
  onReadDone: (read: { source_id: string; plate_text: string; confidence: number; ocr_model: string | null; detection_confidence: number | null }) => void,
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
      onReadDone({
        source_id: sourceId,
        plate_text: body.plate_text,
        // We don't have a separate OCR confidence yet (Claude doesn't expose
        // one). Use the detection confidence as a proxy so the column has
        // signal even before we add a dedicated rerank pass.
        confidence: detectionConfidence,
        ocr_model: body.model ?? null,
        detection_confidence: detectionConfidence,
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

function _formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}
