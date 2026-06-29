import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { MODELS, DEFAULT_MODEL_ID, getModel } from "../lib/models";
import { fetchServingStatus } from "../lib/serving-status";
import { SAMPLE_VIDEOS, defaultSampleForModel, getSampleVideo } from "../lib/samples";
import { useWebcamStream } from "../lib/useWebcamStream";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { usePollingEffect } from "../lib/usePollingEffect";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";

// Sources the user can feed into the detector. The Data + AI Summit expo-floor
// clip is the default "Live" source so an unattended booth display shows a
// recognizable crowd instead of prompting for the device camera; the webcam
// stays available as a second entry under the "Live" group. Everything else
// maps onto SAMPLE_VIDEOS proxied through /api/sample-videos/:id.
const WEBCAM_SOURCE_ID = "webcam";
// SAMPLE_VIDEOS id of the expo-floor clip rendered under "Live" (see samples.ts).
const LIVE_SOURCE_ID = "expo-floor";

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

  const [fps, setFps] = useState<number>(DEFAULT_FPS);
  const [status, setStatus] = useState<string>("");
  const [statusKind, setStatusKind] = useState<"idle" | "info" | "error">("idle");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [saving, setSaving] = useState<boolean>(false);
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID);
  const [sourceId, setSourceId] = useState<string>(LIVE_SOURCE_ID);
  // Tracks when the current /api/detect tick started. Used for the on-video
  // spinner overlay; we render `now - pendingSince` so the user gets a live
  // elapsed counter during cold starts.
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [endpointReady, setEndpointReady] = useState(true);
  const [endpointState, setEndpointState] = useState("");
  const activeModel = useMemo(() => getModel(modelId) ?? MODELS[0], [modelId]);
  const activeSample = useMemo(
    () => (sourceId === WEBCAM_SOURCE_ID ? null : getSampleVideo(sourceId) ?? null),
    [sourceId],
  );

  // Source switcher: exactly one of (webcam, sample) is active at a time.
  // Both hooks gate on `isActive` so the inactive one stays idle and
  // releases the <video> element for the other to own. The webcam hook's
  // cleanup also clears srcObject when the user switches *to* a sample,
  // which lets the sample hook's `video.src = ...` take over cleanly.
  const webcamActive = isActive && sourceId === WEBCAM_SOURCE_ID;
  const sampleActive = isActive && sourceId !== WEBCAM_SOURCE_ID;
  const { videoSize: webcamVideoSize, status: cameraStatus } = useWebcamStream(videoRef, {
    isActive: webcamActive,
    facingMode: "environment",
  });
  const { videoSize: sampleVideoSizeFromHook, status: sampleStatus } = useSampleVideoStream(videoRef, {
    isActive: sampleActive,
    sample: activeSample,
  });

  // Mirror whichever source's status the user is currently looking at
  // into the page's status pill. Picking the right source means a sample
  // load error doesn't leak into webcam mode and vice versa.
  useEffect(() => {
    if (sourceId === WEBCAM_SOURCE_ID) {
      if (cameraStatus.kind === "ready" || cameraStatus.kind === "loading") {
        setStatus(cameraStatus.message);
        setStatusKind("info");
      } else if (cameraStatus.kind !== "idle") {
        setStatus(cameraStatus.message);
        setStatusKind("error");
      }
      return;
    }
    if (sampleStatus.kind === "loading") {
      setStatus(sampleStatus.message);
      setStatusKind("info");
    } else if (sampleStatus.kind === "error") {
      setStatus(sampleStatus.message);
      setStatusKind("error");
    } else if (sampleStatus.kind === "playing") {
      // Don't clobber the detector's own messages once playback starts;
      // the detector tick body owns the status from here on.
      setStatus((prev) => (prev === "Loading clip..." || prev === "Loading sample..." ? "" : prev));
    }
  }, [cameraStatus, sampleStatus, sourceId]);

  // Use the intrinsic resolution from whichever source is currently active.
  const videoSize = sourceId === WEBCAM_SOURCE_ID ? webcamVideoSize : sampleVideoSizeFromHook;

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

  usePollingEffect(refreshServingStatus, { isActive, intervalMs: SERVING_STATUS_POLL_MS });

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

  const tickIntervalMs = useMemo(() => {
    const clamped = Math.max(MIN_FPS, Math.min(MAX_FPS, fps));
    return 1000 / clamped;
  }, [fps]);

  const tick = useCallback(async () => {
    if (!videoRef.current) return;
    const frame = await captureVideoFrameForDetection(videoRef.current);
    if (!frame) return;
    setPendingSince(Date.now());
    try {
      const result = await callDetector(frame.image, { model: modelId, fingerprint: frame.fingerprint });
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
      setPendingSince(null);
    }
  }, [modelId]);

  useDetectionLoop({ isActive, intervalMs: tickIntervalMs, tick });

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

  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => ({
        bbox: d.bbox,
        color: activeModel.color,
        label: `${d.label} ${(d.confidence * 100).toFixed(0)}%`,
        fillAlpha: 0,
      })),
    [detections, activeModel.color],
  );

  useEffect(() => {
    drawBboxOverlay(canvasRef.current, videoRef.current, videoSize, overlayBoxes);
  }, [overlayBoxes, videoSize]);

  const handleSaveSnapshot = async () => {
    if (!videoRef.current || saving) return;
    const frame = await captureVideoFrameForDetection(videoRef.current, {
      maxDimension: SNAPSHOT_MAX_DIMENSION,
      quality: 0.78,
    });
    if (!frame) {
      toast.error("No frame to capture yet.");
      return;
    }
    setSaving(true);
    try {
      const result = await callDetector(frame.image, { persist: true, model: modelId, fingerprint: frame.fingerprint });
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
  // The expo-floor clip is presented under "Live"; keep it out of the
  // "Sample clips" group so it isn't listed twice.
  const liveSample = getSampleVideo(LIVE_SOURCE_ID);
  const sampleClips = SAMPLE_VIDEOS.filter((s) => s.id !== LIVE_SOURCE_ID);

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
                    {liveSample && (
                      <SelectItem value={liveSample.id}>{liveSample.name}</SelectItem>
                    )}
                    <SelectItem value={WEBCAM_SOURCE_ID}>Webcam</SelectItem>
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Sample clips</SelectLabel>
                    {sampleClips.map((s) => (
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
                {status || "Initializing..."}
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
        <div className="text-sm font-medium">Warming up the camera AI</div>
        <div className="text-xs text-slate-300">
          First detection in {seconds}s{stateHint}
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
