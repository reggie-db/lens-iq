import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from "@databricks/appkit-ui/react";
import { AlertTriangle, Cone, Droplets, Loader2 } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { SAMPLE_VIDEOS, getSampleVideo } from "../lib/samples";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";

// Spill response view.
//
// The canonical aisle-spill-then-cone clip (UK supermarket CCTV, 36s long)
// shows a wet patch on the floor for the first ~27s, then a worker deploys
// a yellow CAUTION WET FLOOR cone at 0:27. We run both the `spill` detector
// and the `wet_floor_sign` detector against the same captured frame each
// tick so the page can show:
//   1. spill bbox (yellow)            -> "we see the hazard"
//   2. wet_floor_sign bbox (orange)   -> "operator responded"
//
// The Lakebase counter measures wall-clock latency between the first spill
// detection of a cycle and the first cone detection of that cycle. Cycle
// state lives in the page and resets when:
//   - the video loops back to the start, or
//   - the source is changed.
//
// Completed cycles (both spill + cone seen) get POSTed to /api/spill-cycles
// for persistence; the summary endpoint feeds "last / avg / fastest" cards.
//
// The page is intentionally controls-free: no scrub slider, no buttons. The
// clip auto-loops so the demo runs hands-free and the metric on the
// summary cards is always the real spill-to-cone latency from this run.

const FEED_FPS = 1.5;
const TICK_INTERVAL_MS = Math.round(1000 / FEED_FPS);
const RECENT_REFRESH_MS = 5_000;
const SUMMARY_REFRESH_MS = 5_000;
const RECENT_LIMIT = 25;

// Per-detector confidence thresholds passed to /api/detect.
//
// Spill: backing model spills-ax5xv/2 emits the REAL spill on the canonical
// aisle clip at conf 0.05-0.09 (see databricks.yml -> deploy_spill comments).
// callDetector defaults to conf=0.35 which the inference SDK uses to gate
// its own NMS pass BEFORE the served PyFunc's post-filter ever sees the
// predictions, so anything below 0.35 would get silently dropped upstream.
// We send 0.03 here so the SDK forwards everything 3%+; the PyFunc then
// enforces its own min_confidence=0.04 floor plus the geometric filters
// (area, y_center) that reject the model's known FPs. Cone fires at
// 0.83-0.87 so the default 0.35 is plenty for wet_floor_sign.
const CONF_SPILL = 0.03;
const CONF_CONE = 0.35;

const COLOR_SPILL = "#eab308";
const COLOR_CONE = "#f97316";
const COLOR_NEUTRAL = "#0ea5e9";

interface SpillsPageProps {
  isActive: boolean;
}

interface SummaryResponse {
  cycles: number;
  avg_response_ms: number | null;
  min_response_ms: number | null;
  last_response_ms: number | null;
  last_ts: string | null;
}

interface RecentCycle {
  id: number;
  ts: string;
  source_id: string;
  spill_first_ts: string;
  cone_first_ts: string;
  response_ms: number;
  was_assisted: boolean;
}

interface CycleState {
  spillFirstTs: number | null;
  coneFirstTs: number | null;
  responseMs: number | null;
  liveElapsedMs: number;
}

const EMPTY_CYCLE: CycleState = {
  spillFirstTs: null,
  coneFirstTs: null,
  responseMs: null,
  liveElapsedMs: 0,
};

export function SpillsPage({ isActive }: SpillsPageProps) {
  const [sourceId, setSourceId] = useState("aisle-spill-then-cone");
  const [cycle, setCycle] = useState<CycleState>(EMPTY_CYCLE);
  const [summary, setSummary] = useState<SummaryResponse>({
    cycles: 0, avg_response_ms: null, min_response_ms: null,
    last_response_ms: null, last_ts: null,
  });
  const [recent, setRecent] = useState<RecentCycle[]>([]);

  // Clips that exercise spill + wet_floor_sign together. The default
  // `aisle-spill-then-cone` is the canonical end-to-end demo; the others
  // are kept selectable so the page can be pointed at any wet-floor or
  // slip-fall sample while we iterate on detectors.
  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter(
      (s) => s.models.includes("spill") || s.models.includes("wet_floor_sign"),
    ),
    [],
  );

  const handleCycleUpdate = useCallback((next: CycleState) => {
    setCycle(next);
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/spill-cycles/summary");
      if (!res.ok) return;
      const body = (await res.json()) as SummaryResponse;
      setSummary(body);
    } catch {
      // non-fatal
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch(`/api/spill-cycles/recent?limit=${RECENT_LIMIT}`);
      if (!res.ok) return;
      const body = (await res.json()) as { rows: RecentCycle[] };
      setRecent(body.rows);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void loadSummary();
    const id = setInterval(() => void loadSummary(), SUMMARY_REFRESH_MS);
    return () => clearInterval(id);
  }, [isActive, loadSummary]);

  useEffect(() => {
    if (!isActive) return;
    void loadRecent();
    const id = setInterval(() => void loadRecent(), RECENT_REFRESH_MS);
    return () => clearInterval(id);
  }, [isActive, loadRecent]);

  const handleCycleComplete = useCallback(() => {
    // Fire-and-forget refresh so the summary cards and recent list reflect
    // the brand-new cycle without waiting for the next poll tick.
    void loadSummary();
    void loadRecent();
  }, [loadSummary, loadRecent]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Current response</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: cycle.responseMs != null ? COLOR_CONE : cycle.spillFirstTs != null ? COLOR_SPILL : "#0f172a" }}
              >
                {cycle.responseMs != null
                  ? _formatMs(cycle.responseMs)
                  : cycle.spillFirstTs != null
                  ? _formatMs(cycle.liveElapsedMs)
                  : "-"}
              </span>
              <span className="text-xs text-slate-500">
                {cycle.responseMs != null
                  ? "spill to cone"
                  : cycle.spillFirstTs != null
                  ? "waiting for cone"
                  : "no spill yet"}
              </span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Last cycle</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">
                {summary.last_response_ms != null ? _formatMs(summary.last_response_ms) : "-"}
              </span>
              <span className="text-xs text-slate-500">most recent</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Avg response</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums" style={{ color: COLOR_NEUTRAL }}>
                {summary.avg_response_ms != null ? _formatMs(summary.avg_response_ms) : "-"}
              </span>
              <span className="text-xs text-slate-500">last {summary.cycles} cycle{summary.cycles === 1 ? "" : "s"}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Fastest response</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums" style={{ color: COLOR_CONE }}>
                {summary.min_response_ms != null ? _formatMs(summary.min_response_ms) : "-"}
              </span>
              <span className="text-xs text-slate-500">best so far</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <SpillFeed
            isActive={isActive}
            sourceId={sourceId}
            candidates={candidates}
            onSourceChange={setSourceId}
            onCycleUpdate={handleCycleUpdate}
            onCycleComplete={handleCycleComplete}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent spill responses</CardTitle>
            <CardDescription>
              Time from spill to cone, newest at the top.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[460px] overflow-y-auto">
              {recent.length === 0 ? (
                <div className="text-sm text-slate-500">No cycles recorded yet. Wait for a spill and cone to be detected.</div>
              ) : (
                recent.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-slate-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <Cone className="w-4 h-4 shrink-0" style={{ color: COLOR_CONE }} />
                      <div className="min-w-0">
                        <div className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                          {_formatMs(r.response_ms)}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {r.was_assisted ? "operator-assisted" : "auto-detected"}
                        </div>
                      </div>
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

interface SpillFeedProps {
  isActive: boolean;
  sourceId: string;
  candidates: typeof SAMPLE_VIDEOS;
  onSourceChange: (id: string) => void;
  onCycleUpdate: (cycle: CycleState) => void;
  onCycleComplete: () => void;
}

interface OverlayDetection extends Detection {
  kind: "spill" | "cone";
}

// Single CCTV feed that runs spill + wet_floor_sign in parallel each tick.
// Tracks the wall-clock delta between the first spill detection and the
// first cone detection of the current cycle and persists complete cycles
// to Lakebase. Auto-loops the clip; no scrubbing, no manual buttons.
function SpillFeed({
  isActive, sourceId, candidates, onSourceChange, onCycleUpdate, onCycleComplete,
}: SpillFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Cycle state lives in a ref so the detector tick can read/mutate it
  // without re-creating the tick handler on every state update.
  const cycleRef = useRef<CycleState>(EMPTY_CYCLE);
  const persistedRef = useRef(false);
  // Used only to detect a loop wraparound and reset the cycle.
  const lastVideoTimeRef = useRef(0);

  const [detections, setDetections] = useState<OverlayDetection[]>([]);
  // Detector tick status (rolling: "watching..." / "Detected 1 spill" /
  // "Detector unavailable"). The video-stream hook owns its own status
  // (loading / playing / error); we keep them separate so a detector
  // hiccup doesn't blank the "playing" indicator and vice versa.
  const [detectorStatus, setDetectorStatus] = useState<string>("");
  const [detectorError, setDetectorError] = useState<string | null>(null);

  const sample = useMemo(() => getSampleVideo(sourceId) ?? null, [sourceId]);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
  });

  const resetCycle = useCallback(() => {
    cycleRef.current = EMPTY_CYCLE;
    persistedRef.current = false;
    onCycleUpdate(EMPTY_CYCLE);
  }, [onCycleUpdate]);

  // Wipe per-clip state when the source changes - tracks from one clip
  // shouldn't carry into the next.
  useEffect(() => {
    resetCycle();
    setDetections([]);
    lastVideoTimeRef.current = 0;
  }, [sourceId, resetCycle]);

  // Loop-wraparound detector: when the clip restarts the cycle resets so
  // the next pass measures cleanly. This is the only timeupdate consumer
  // on this page so it stays separate from the shared video-stream hook.
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;
    const syncTime = () => {
      const t = video.currentTime;
      if (t + 0.5 < lastVideoTimeRef.current) resetCycle();
      lastVideoTimeRef.current = t;
    };
    video.addEventListener("timeupdate", syncTime);
    return () => video.removeEventListener("timeupdate", syncTime);
  }, [isActive, sample, resetCycle]);

  // Live counter while we're between spill detection and cone detection -
  // pushes a per-tick liveElapsedMs into the parent so the "Current response"
  // card animates upward like a stopwatch instead of jumping at the end.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      const cur = cycleRef.current;
      if (cur.spillFirstTs == null || cur.coneFirstTs != null) return;
      const next: CycleState = { ...cur, liveElapsedMs: Date.now() - cur.spillFirstTs };
      cycleRef.current = next;
      onCycleUpdate(next);
    }, 100);
    return () => clearInterval(id);
  }, [isActive, onCycleUpdate]);

  // Detector tick. Calls spill and wet_floor_sign in parallel against the
  // same captured frame so both detections come from the exact same pixels.
  // useDetectionLoop handles the in-flight guard so we don't stack requests
  // during a cold start.
  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const frame = captureVideoFrameForDetection(video);
    if (!frame) return;
    try {
      const [spillResult, coneResult] = await Promise.all([
        callDetector(frame.image, { model: "spill", conf: CONF_SPILL }).catch(() => ({ detections: [], saved: null })),
        callDetector(frame.image, { model: "wet_floor_sign", conf: CONF_CONE }).catch(() => ({ detections: [], saved: null })),
      ]);
      const spillBoxes: OverlayDetection[] = spillResult.detections.map((d) => ({
        ...d,
        bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        kind: "spill",
      }));
      const coneBoxes: OverlayDetection[] = coneResult.detections.map((d) => ({
        ...d,
        bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        kind: "cone",
      }));
      setDetections([...spillBoxes, ...coneBoxes]);
      setDetectorError(null);

      const now = Date.now();
      let mutated = false;
      const next: CycleState = { ...cycleRef.current };
      if (spillBoxes.length > 0 && next.spillFirstTs == null) {
        next.spillFirstTs = now;
        mutated = true;
      }
      if (
        coneBoxes.length > 0
        && next.coneFirstTs == null
        && next.spillFirstTs != null
      ) {
        next.coneFirstTs = now;
        next.responseMs = Math.max(0, now - next.spillFirstTs);
        mutated = true;
        // Persist exactly once per cycle (the tick may fire again before
        // the loop wraps; cycleRef carries the completed state).
        if (!persistedRef.current) {
          persistedRef.current = true;
          void _persistCycle({
            source_id: sourceId,
            spill_first_ts: new Date(next.spillFirstTs).toISOString(),
            cone_first_ts: new Date(next.coneFirstTs).toISOString(),
            response_ms: next.responseMs,
          }).then((ok) => { if (ok) onCycleComplete(); });
        }
      }
      if (mutated) {
        next.liveElapsedMs = next.spillFirstTs != null
          ? Math.max(0, (next.coneFirstTs ?? now) - next.spillFirstTs)
          : 0;
        cycleRef.current = next;
        onCycleUpdate(next);
      }

      const parts: string[] = [];
      if (spillBoxes.length > 0) parts.push(`${spillBoxes.length} spill`);
      if (coneBoxes.length > 0) parts.push(`${coneBoxes.length} cone`);
      setDetectorStatus(parts.length > 0 ? `Detected ${parts.join(" + ")}` : "Watching for spills...");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDetectorError(message);
      setDetectorStatus("Detector unavailable");
    }
  }, [sourceId, onCycleUpdate, onCycleComplete]);

  useDetectionLoop({ isActive, intervalMs: TICK_INTERVAL_MS, tick });

  // Translate the detector results into the shared overlay format. Spill
  // boxes get a colour-tinted fill so the wet patch reads even before the
  // bbox edge - 18% alpha matches the prior behaviour.
  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => {
        const isSpill = d.kind === "spill";
        return {
          bbox: d.bbox,
          color: isSpill ? COLOR_SPILL : COLOR_CONE,
          label: isSpill
            ? `SPILL ${(d.confidence * 100).toFixed(0)}%`
            : `CONE ${(d.confidence * 100).toFixed(0)}%`,
          fillAlpha: 0.18,
          labelAlpha: 1,
        };
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
          <Label htmlFor="spills-source">Source</Label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id="spills-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Spill + wet-floor sign clips</SelectLabel>
                {candidates.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div
          className="relative bg-black rounded-lg overflow-hidden"
          // Match the container's aspect ratio to the source video so
          // `object-contain` letterboxing disappears - the video element
          // fills the container exactly and overlay bboxes line up edge
          // to edge. Falls back to 16:9 until videoSize is known.
          style={{
            aspectRatio: videoSize.w > 0 && videoSize.h > 0
              ? `${videoSize.w} / ${videoSize.h}`
              : "16 / 9",
          }}
        >
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
          <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
            <Badge
              variant="outline"
              className="gap-1.5 backdrop-blur bg-white/85"
              style={{ borderColor: COLOR_SPILL, color: COLOR_SPILL }}
            >
              <Droplets className="w-3 h-3" />
              Spill
            </Badge>
            <Badge
              variant="outline"
              className="gap-1.5 backdrop-blur bg-white/85"
              style={{ borderColor: COLOR_CONE, color: COLOR_CONE }}
            >
              <Cone className="w-3 h-3" />
              Wet floor sign
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-slate-500 justify-end">
          {videoStatus.kind === "loading" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {videoStatus.kind === "loading"
            ? videoStatus.message
            : videoStatus.kind === "error"
            ? videoStatus.message
            : detectorStatus || "Initializing..."}
        </div>

        {detectorError && videoStatus.kind !== "error" && (
          <div className="text-xs text-red-600 break-words flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{detectorError}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function _persistCycle(body: {
  source_id: string;
  spill_first_ts: string;
  cone_first_ts: string;
  response_ms: number;
}): Promise<boolean> {
  try {
    // was_assisted has been removed from the UI but the server still
    // accepts the column; send false explicitly so the schema is happy
    // and historic rows can be filtered by `was_assisted = false` to
    // count just the auto-detected cycles.
    const res = await fetch("/api/spill-cycles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, was_assisted: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function _formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(2)}s`;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m ${s}s`;
}

function _formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}
