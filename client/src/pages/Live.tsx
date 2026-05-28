import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label,
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
  Spinner,
} from "@databricks/appkit-ui/react";
import { Save } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  SNAPSHOT_MAX_DIMENSION,
  captureVideoFrameForDetection,
  requestCameraStream,
  scaleDetectionBbox,
  stopMediaStream,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { MODELS, DEFAULT_MODEL_ID, getModel } from "../lib/models";
import { fetchServingStatus } from "../lib/serving-status";
import { SAMPLE_VIDEOS, defaultSampleForModel, getSampleVideo, sampleVideoUrl } from "../lib/samples";

// Sources the user can feed into the detector. "webcam" is the default; the
// other entries map onto SAMPLE_VIDEOS proxied through /api/sample-videos/:id.
const WEBCAM_SOURCE_ID = "webcam";

// Poll serving-status at the same cadence as the server-side AppKit cache TTL.
const SERVING_STATUS_POLL_MS = 45_000;

// A detect request that's been in flight this long without responding almost
// certainly means the endpoint scaled to zero and we're paying for a cold
// start. At that point we (1) flip the on-video overlay from a small spinner
// pill to the full "Waking endpoint" treatment, and (2) force-refresh the
// cached serving-status so the message reflects the true endpoint state
// instead of relying on the 45s background poll.
const PENDING_OVERLAY_THRESHOLD_MS = 2000;
const PENDING_FORCE_REFRESH_MS = 3000;

// Live webcam preview that periodically grabs a frame, posts it to the
// configured detector serving endpoint via /api/detect, and overlays the
// returned bounding boxes on the video. A "Save snapshot" button captures the
// current frame with persist=true so it lands in the UC `frames` volume and
// `detections` table. The right-hand panel keeps a rolling window of the
// last `HISTORY_WINDOW_MS` of detections so the demo shows an aggregate
// "X detections in the last minute" view that doesn't reset on every frame.

const DEFAULT_FPS = 2;
const MIN_FPS = 1;
const MAX_FPS = 10;
const HISTORY_WINDOW_MS = 60_000;
const HISTORY_BUCKETS = 12;
const TOP_LABELS = 6;

interface HistoryEntry {
  ts: number;
  label: string;
}

interface LivePageProps {
  isActive: boolean;
}

export function LivePage({ isActive }: LivePageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const inFlightRef = useRef<boolean>(false);

  const [fps, setFps] = useState<number>(DEFAULT_FPS);
  const [status, setStatus] = useState<string>("");
  const [statusKind, setStatusKind] = useState<"idle" | "info" | "error">("idle");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [saving, setSaving] = useState<boolean>(false);
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID);
  const [sourceId, setSourceId] = useState<string>(WEBCAM_SOURCE_ID);
  // Tracks when the current /api/detect tick started. Used for the on-video
  // spinner overlay; we render `now - pendingSince` so the user gets a live
  // elapsed counter during cold starts.
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [endpointReady, setEndpointReady] = useState(true);
  const [endpointState, setEndpointState] = useState("");
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const activeModel = useMemo(() => getModel(modelId) ?? MODELS[0], [modelId]);
  const activeSample = useMemo(
    () => (sourceId === WEBCAM_SOURCE_ID ? null : getSampleVideo(sourceId) ?? null),
    [sourceId],
  );

  // Manage the <video> element's source. For webcam we attach a MediaStream
  // (live device feed). For sample videos we set `src` to a proxied URL that
  // streams the upstream Roboflow MP4 with CORS headers, so canvas captures
  // don't taint and the detection loop keeps working.
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;

    const attachWebcam = async () => {
      const stream = await requestCameraStream("environment");
      if (cancelled) {
        stopMediaStream(stream);
        return;
      }
      if (!stream) {
        setStatus("Camera access denied");
        setStatusKind("error");
        return;
      }
      video.srcObject = stream;
      video.src = "";
      video.loop = false;
      video.muted = true;
      trackRef.current = stream.getVideoTracks()[0] ?? null;
      const settings = trackRef.current?.getSettings();
      setStatus(`Camera ready (${settings?.width ?? "?"}x${settings?.height ?? "?"})`);
      setStatusKind("info");
      await video.play().catch(() => undefined);
    };

    const attachSample = async (sampleId: string) => {
      const sample = getSampleVideo(sampleId);
      if (!sample) {
        setStatus(`Unknown sample: ${sampleId}`);
        setStatusKind("error");
        return;
      }
      video.srcObject = null;
      trackRef.current = null;
      video.crossOrigin = "anonymous";
      video.loop = true;
      video.muted = true;
      video.src = sampleVideoUrl(sample);
      setStatus("Loading sample...");
      setStatusKind("info");
      await video.play().catch(() => undefined);
    };

    if (sourceId === WEBCAM_SOURCE_ID) {
      void attachWebcam();
    } else {
      void attachSample(sourceId);
    }

    const syncVideoSize = () => {
      setVideoSize({
        w: video.videoWidth || 0,
        h: video.videoHeight || 0,
      });
    };
    video.addEventListener("loadedmetadata", syncVideoSize);
    video.addEventListener("resize", syncVideoSize);

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", syncVideoSize);
      video.removeEventListener("resize", syncVideoSize);
      stopMediaStream((video.srcObject as MediaStream | null) ?? null);
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
      trackRef.current = null;
    };
  }, [isActive, sourceId]);

  // Cached GET /api/serving-status/:alias - the AppKit CacheManager fronts
  // the Workspace API so we can poll cheaply. The overlay reads this state
  // directly instead of guessing from /api/detect latency.
  const refreshServingStatus = useCallback(
    async (force = false) => {
      try {
        const status = await fetchServingStatus(activeModel.servingAlias, { force });
        setEndpointReady(status.ready);
        setEndpointState(status.state);
      } catch {
        setEndpointReady(true);
      }
    },
    [activeModel.servingAlias],
  );

  useEffect(() => {
    if (!isActive) return;
    void refreshServingStatus();
    const id = setInterval(() => void refreshServingStatus(), SERVING_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [isActive, refreshServingStatus]);

  // If a detect request has been in flight long enough to look like a cold
  // start, force-refresh the cached serving-status so the overlay can switch
  // from "Detecting" to "Waking endpoint" based on actual state instead of
  // continuing to trust the last 45s-old poll.
  useEffect(() => {
    if (pendingSince == null) return;
    const elapsed = now - pendingSince;
    if (elapsed < PENDING_FORCE_REFRESH_MS) return;
    if (!endpointReady) return;
    void refreshServingStatus(true);
  }, [pendingSince, now, endpointReady, refreshServingStatus]);

  useEffect(() => {
    if (!isActive) return;
    const clamped = Math.max(MIN_FPS, Math.min(MAX_FPS, fps));
    const intervalMs = 1000 / clamped;

    const tick = async () => {
      if (inFlightRef.current || !videoRef.current) return;
      const frame = captureVideoFrameForDetection(videoRef.current);
      if (!frame) return;
      inFlightRef.current = true;
      setPendingSince(Date.now());
      try {
        const result = await callDetector(frame.image, { model: modelId });
        const scaled = result.detections.map((d) => ({
          ...d,
          bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        }));
        setDetections(scaled);
        const ts = Date.now();
        const newEntries: HistoryEntry[] = scaled.map((d) => ({ ts, label: d.label }));
        if (newEntries.length > 0) {
          setHistory((prev) => {
            const cutoff = ts - HISTORY_WINDOW_MS;
            const trimmed = prev.length > 0 && prev[0].ts < cutoff
              ? prev.filter((e) => e.ts >= cutoff)
              : prev;
            return [...trimmed, ...newEntries];
          });
        }
        setStatus(
          scaled.length > 0
            ? `Detected ${scaled.length} object(s)`
            : "No objects detected in this frame",
        );
        setStatusKind("info");
      } catch (err) {
        setDetections([]);
        setStatus(err instanceof Error ? err.message : String(err));
        setStatusKind("error");
      } finally {
        inFlightRef.current = false;
        setPendingSince(null);
      }
    };

    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [fps, isActive, modelId]);

  // When the user switches model, wipe stale state so the new model starts
  // with a clean rolling-window panel and no leftover bounding boxes.
  useEffect(() => {
    setDetections([]);
    setHistory([]);
  }, [modelId]);

  // Prune the history window and bump `now` once per second so per-bucket
  // counts/labels stay fresh even when the detector returns no detections.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      const cutoff = Date.now() - HISTORY_WINDOW_MS;
      setHistory((prev) => (prev.length > 0 && prev[0].ts < cutoff ? prev.filter((e) => e.ts >= cutoff) : prev));
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

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
    const color = activeModel.color;
    const fillColor = _hexToRgba(color, 0.9);
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
    ctx.font = `${Math.max(14, Math.round(canvas.width / 60))}px sans-serif`;
    for (const d of detections) {
      const [x1, y1, x2, y2] = d.bbox;
      ctx.strokeStyle = color;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = `${d.label} ${(d.confidence * 100).toFixed(0)}%`;
      const padding = 4;
      const labelHeight = Math.max(18, Math.round(canvas.width / 50));
      const tw = ctx.measureText(label).width + padding * 2;
      ctx.fillStyle = fillColor;
      ctx.fillRect(x1, Math.max(0, y1 - labelHeight), tw, labelHeight);
      ctx.fillStyle = "white";
      ctx.fillText(label, x1 + padding, Math.max(labelHeight - padding, y1 - padding));
    }
  }, [detections, activeModel, videoSize]);

  const handleSaveSnapshot = async () => {
    if (!videoRef.current || saving) return;
    const frame = captureVideoFrameForDetection(videoRef.current, {
      maxDimension: SNAPSHOT_MAX_DIMENSION,
      quality: 0.78,
    });
    if (!frame) {
      toast.error("No frame to capture yet.");
      return;
    }
    setSaving(true);
    try {
      const result = await callDetector(frame.image, { persist: true, model: modelId });
      if (result.saved) {
        toast.success(`Saved ${result.saved.frame_id} with ${result.detections.length} detection(s)`);
      } else {
        toast.error("Detection ran but persistence failed (see server logs).");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setSaving(false);
    }
  };

  const stats = useMemo(() => {
    const cutoff = now - HISTORY_WINDOW_MS;
    const recent = history.filter((e) => e.ts >= cutoff);

    const counts = new Map<string, number>();
    for (const e of recent) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);

    const byLabel = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    const bucketMs = HISTORY_WINDOW_MS / HISTORY_BUCKETS;
    const buckets = Array.from({ length: HISTORY_BUCKETS }, (_, i) => {
      const start = cutoff + i * bucketMs;
      const end = start + bucketMs;
      const secondsAgo = Math.round((now - end) / 1000);
      return {
        label: secondsAgo <= 0 ? "now" : `-${secondsAgo}s`,
        count: 0,
      };
    });
    for (const e of recent) {
      const idx = Math.min(HISTORY_BUCKETS - 1, Math.max(0, Math.floor((e.ts - cutoff) / bucketMs)));
      buckets[idx].count += 1;
    }

    return { total: recent.length, byLabel, buckets };
  }, [history, now]);

  const currentFrameLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }, [detections]);

  const windowSeconds = Math.round(HISTORY_WINDOW_MS / 1000);
  // Each detector now lives on its own serving endpoint. Group by purpose
  // in the selector: the general-purpose YOLO endpoint vs the
  // single-purpose detectors (license plate, spill, etc.) so users see
  // the use cases without us hard-coding the alias list.
  const yoloModels = MODELS.filter((m) => m.servingAlias === "detector");
  const specialtyModels = MODELS.filter((m) => m.servingAlias !== "detector");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2">
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5" data-tour="live-source">
              <Label htmlFor="source">Source</Label>
              <Select
                value={sourceId}
                onValueChange={(v) => {
                  setSourceId(v);
                  // If the user picked a sample, auto-switch to a detector the
                  // sample is curated for so the demo "just works".
                  if (v !== WEBCAM_SOURCE_ID) {
                    const sample = getSampleVideo(v);
                    if (sample && sample.models.length > 0 && !sample.models.includes(modelId)) {
                      setModelId(sample.models[0]);
                    }
                  }
                }}
              >
                <SelectTrigger id="source" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Live</SelectLabel>
                    <SelectItem value={WEBCAM_SOURCE_ID}>Webcam</SelectItem>
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Sample clips</SelectLabel>
                    {SAMPLE_VIDEOS.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5" data-tour="live-detector">
              <Label htmlFor="model">Detector</Label>
              <Select
                value={modelId}
                onValueChange={(v) => {
                  setModelId(v);
                  // Symmetric helper: when the user picks a detector while on
                  // the webcam, leave them alone. If they're already on a
                  // sample that doesn't suit the new detector, jump to a
                  // sample that does (if one exists).
                  if (sourceId !== WEBCAM_SOURCE_ID) {
                    const model = getModel(v);
                    if (model && !activeSample?.models.includes(v)) {
                      const suggested = defaultSampleForModel(model);
                      if (suggested) setSourceId(suggested.id);
                    }
                  }
                }}
              >
                <SelectTrigger id="model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yoloModels.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>General object detector</SelectLabel>
                      {yoloModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {specialtyModels.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Specialty detectors</SelectLabel>
                      {specialtyModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="relative bg-black rounded-lg overflow-hidden aspect-video" data-tour="live-video">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              loop={sourceId !== WEBCAM_SOURCE_ID}
              className="absolute inset-0 w-full h-full object-contain"
            />
            {/* `object-contain` makes the canvas letterbox itself to its
                intrinsic width/height (set to the video's native resolution)
                inside the 16:9 container - exactly like the video element
                above. Without this, the canvas pixel buffer is stretched to
                fill the container and bounding boxes drift into the black
                letterbox bars when the source aspect ratio != 16:9. */}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            />
            <Badge
              variant="outline"
              className="absolute top-2 left-2 gap-1.5 backdrop-blur bg-white/85"
              style={{ borderColor: activeModel.color, color: activeModel.color }}
            >
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: activeModel.color }} />
              {activeModel.name}
            </Badge>
            <DetectorPendingOverlay
              pendingSince={pendingSince}
              endpointReady={endpointReady}
              endpointState={endpointState}
              now={now}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div className="space-y-2">
              <Label htmlFor="fps">Frame rate (FPS)</Label>
              <Input
                id="fps"
                type="number"
                min={MIN_FPS}
                max={MAX_FPS}
                value={fps}
                onChange={(e) => setFps(parseInt(e.target.value, 10) || DEFAULT_FPS)}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <div
                className={
                  "text-xs break-words " +
                  (statusKind === "error"
                    ? "text-red-600 font-medium"
                    : statusKind === "info"
                    ? "text-slate-600"
                    : "text-slate-400")
                }
              >
                {status || "Initializing camera..."}
              </div>
            </div>
            <Button
              onClick={handleSaveSnapshot}
              disabled={saving}
              className="gap-2"
              data-tour="live-snapshot"
            >
              <Save className="w-4 h-4" />
              {saving ? "Saving..." : "Save snapshot"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detections - last {windowSeconds}s</CardTitle>
          <CardDescription>
            Rolling window for <span className="font-medium" style={{ color: activeModel.color }}>{activeModel.name}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold text-slate-900 tabular-nums">{stats.total}</span>
            <span className="text-sm text-slate-500">detections in past {windowSeconds}s</span>
          </div>

          <div className="h-24 -mx-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.buckets} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} width={24} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: _hexToRgba(activeModel.color, 0.08) }}
                  contentStyle={{ fontSize: 12, padding: "4px 8px" }}
                  labelFormatter={(v) => `t=${v}`}
                />
                <Bar dataKey="count" fill={activeModel.color} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">By label</div>
            <div className="space-y-1.5">
              {stats.byLabel.length === 0 && (
                <div className="text-sm text-slate-500">No detections yet.</div>
              )}
              {stats.byLabel.slice(0, TOP_LABELS).map((row) => {
                const pct = stats.total > 0 ? (row.count / stats.total) * 100 : 0;
                return (
                  <div key={row.label} className="space-y-0.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize text-slate-700">{row.label}</span>
                      <span className="tabular-nums text-slate-600">{row.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: activeModel.color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {currentFrameLabels.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Current frame</div>
              <div className="flex flex-wrap gap-1.5">
                {currentFrameLabels.map((row) => (
                  <Badge key={row.label} variant="outline" className="gap-1">
                    <span className="capitalize">{row.label}</span>
                    <span className="text-slate-500 tabular-nums">x{row.count}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Two-state spinner overlay on the video.
//
// - pending < PENDING_OVERLAY_THRESHOLD_MS: nothing rendered (steady-state
//   polling stays quiet so the UI doesn't flash every tick).
// - pending >= threshold and endpoint READY: small "Detecting" pill in the
//   corner. The request is just slower than usual but the endpoint is up.
// - pending >= threshold and endpoint NOT READY: full-card "Waking endpoint"
//   overlay with elapsed counter, because cold starts can take 30-60s and the
//   user needs to know the page isn't stuck.
//
// The endpointReady flag is driven by the AppKit-cached /api/serving-status,
// which is force-refreshed after PENDING_FORCE_REFRESH_MS so we don't keep
// rendering "Detecting" when the endpoint silently scaled to zero.
function DetectorPendingOverlay({
  pendingSince,
  endpointReady,
  endpointState,
  now,
}: {
  pendingSince: number | null;
  endpointReady: boolean;
  endpointState: string;
  now: number;
}) {
  if (pendingSince == null) return null;
  const elapsed = Math.max(0, now - pendingSince);
  if (elapsed < PENDING_OVERLAY_THRESHOLD_MS) return null;
  const seconds = Math.floor(elapsed / 1000);

  if (endpointReady) {
    return (
      <div className="absolute top-2 right-2">
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-black/55 text-white text-xs backdrop-blur">
          <Spinner className="size-3.5" />
          <span>Detecting{seconds > 4 ? ` (${seconds}s)` : ""}</span>
        </div>
      </div>
    );
  }

  const stateHint = endpointState && endpointState !== "READY" ? ` (${endpointState})` : "";
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-3 px-5 py-4 rounded-lg bg-black/70 text-white">
        <Spinner className="size-6" />
        <div className="text-sm font-medium">Waking detection endpoint</div>
        <div className="text-xs text-slate-300">
          Model Serving cold start{stateHint}. Elapsed: {seconds}s
        </div>
      </div>
    </div>
  );
}

// Convert a `#rrggbb` color string into an `rgba(...)` string at the given
// alpha. Used to derive translucent fills (bbox label backgrounds, chart
// cursor) from a model's solid accent color.
function _hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return `rgba(220, 38, 38, ${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
