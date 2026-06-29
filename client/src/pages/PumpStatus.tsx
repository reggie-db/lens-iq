import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue, Slider,
} from "@databricks/appkit-ui/react";
import { AlertTriangle, Fuel, Loader2 } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { SAMPLE_VIDEOS, VISION_PLAYBACK_RATE, getSampleVideo } from "../lib/samples";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";

// Pump Status page.
//
// One CV-driven gauge for a gas-station forecourt: how many fuel
// dispensers are currently out of service (a bag/cover tied over the
// nozzle) versus how many are clear and active. Both numbers come from
// a single Claude vision call per frame on the shared `llm` Model
// Serving alias - the page calls /api/detect twice in parallel
// (model=pump_bagged for covered nozzles, model=pump_active for clear
// ones) and the second call hits the image-hash + Lakebase cache
// because both models register identical `labels` + `promptAddendum`
// in server/server.ts VISION_GROUPS.
//
// The summary cards average over the last N detector ticks instead of
// snapping to the latest frame so a single frame where Claude misses a
// half-occluded nozzle doesn't make the live count jitter. The bbox
// overlay still renders the latest frame's detections so a presenter
// can point and say "see, two pumps bagged, six active - 25% down".

const FEED_FPS = 1.0;
const TICK_INTERVAL_MS = Math.round(1000 / FEED_FPS);

const DEFAULT_CONF_BAGGED = 0.4;
const DEFAULT_CONF_ACTIVE = 0.5;

// Rolling window for the "out of service" and "active" cards. Three
// ticks at 1 fps = 3 s, enough to ride through a one-frame miss
// without lagging the presenter behind reality.
const SMOOTH_WINDOW = 3;

const COLOR_BAGGED = "#dc2626";
const COLOR_ACTIVE = "#16a34a";

interface PumpStatusPageProps {
  isActive: boolean;
}

interface CountState {
  bagged: number;
  active: number;
}

const EMPTY_COUNTS: CountState = { bagged: 0, active: 0 };

// Out-of-service rate as a whole-number percent. Returns 0 when no
// dispensers are visible so the card reads "0%" instead of NaN.
function _oosRate(counts: CountState): number {
  const total = counts.bagged + counts.active;
  if (total <= 0) return 0;
  return Math.round((counts.bagged / total) * 100);
}

export function PumpStatusPage({ isActive }: PumpStatusPageProps) {
  // Default to the dedicated montage clip. Fall back to the first
  // pump-tagged sample if the canonical id is ever renamed.
  const [sourceId, setSourceId] = useState(() => {
    const preferred = getSampleVideo("pump-bag-montage");
    if (preferred) return preferred.id;
    const fallback = SAMPLE_VIDEOS.find(
      (s) => s.models.includes("pump_bagged") || s.models.includes("pump_active"),
    );
    return fallback?.id ?? "pump-bag-montage";
  });
  const [live, setLive] = useState<CountState>(EMPTY_COUNTS);
  const [smoothed, setSmoothed] = useState<CountState>(EMPTY_COUNTS);
  const [peakBagged, setPeakBagged] = useState(0);

  // Curated source list: every sample that carries either pump model
  // in its `models` array. Keeps the dropdown self-maintaining as new
  // forecourt clips get added to ./samples.ts.
  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter(
      (s) => s.models.includes("pump_bagged") || s.models.includes("pump_active"),
    ),
    [],
  );

  const handleCountsUpdate = useCallback((tick: CountState) => {
    setLive(tick);
    setPeakBagged((cur) => Math.max(cur, tick.bagged));
  }, []);

  const handleSmoothedUpdate = useCallback((avg: CountState) => {
    setSmoothed(avg);
  }, []);

  // Reset peak/live when the operator switches clips - a peak from a
  // heavily-bagged clip would otherwise stick around when they swap to
  // a fully-active forecourt.
  useEffect(() => {
    setPeakBagged(0);
    setLive(EMPTY_COUNTS);
    setSmoothed(EMPTY_COUNTS);
  }, [sourceId]);

  const oosRate = _oosRate(smoothed);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Out of service</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: COLOR_BAGGED }}
              >
                {smoothed.bagged}
              </span>
              <span className="text-xs text-slate-500">smoothed (3 s window)</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Active pumps</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: COLOR_ACTIVE }}
              >
                {smoothed.active}
              </span>
              <span className="text-xs text-slate-500">smoothed (3 s window)</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Out-of-service rate</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: oosRate >= 50 ? COLOR_BAGGED : "#0f172a" }}
              >
                {oosRate}%
              </span>
              <span className="text-xs text-slate-500">of dispensers in frame</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Peak this clip</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">
                {peakBagged}
              </span>
              <span className="text-xs" style={{ color: COLOR_BAGGED }}>bagged</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PumpFeed
            isActive={isActive}
            sourceId={sourceId}
            candidates={candidates}
            onSourceChange={setSourceId}
            onCountsUpdate={handleCountsUpdate}
            onSmoothedUpdate={handleSmoothedUpdate}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Why this matters</CardTitle>
            <CardDescription>
              Forecourt uptime at a glance, from one Claude vision call.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm text-slate-700">
              <p>
                Each tick the page captures a single frame from the
                forecourt cam and runs two `/api/detect` calls in
                parallel:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-slate-600">
                <li>
                  <span className="font-medium text-slate-900">pump_bagged</span>
                  {" "}counts every nozzle with a bag or cover tied over it (out of service).
                </li>
                <li>
                  <span className="font-medium text-slate-900">pump_active</span>
                  {" "}counts every nozzle that is clear and in service.
                </li>
              </ul>
              <p>
                Both models share the same labels and prompt, so the
                second call hits the image-hash cache and the pair
                costs <strong>one</strong> Claude round-trip per frame.
                A Lakebase L2 cache keyed by the same frame fingerprint
                keeps the loop instant across restarts and replicas.
              </p>
              <p>
                The summary cards smooth over a 3-second window so a
                single occluded frame won't flip the out-of-service
                rate. The bbox overlay still renders the latest frame
                so the count is auditable in real time.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface PumpFeedProps {
  isActive: boolean;
  sourceId: string;
  candidates: typeof SAMPLE_VIDEOS;
  onSourceChange: (id: string) => void;
  onCountsUpdate: (counts: CountState) => void;
  onSmoothedUpdate: (counts: CountState) => void;
}

interface OverlayDetection extends Detection {
  kind: "bagged" | "active";
}

function PumpFeed({
  isActive, sourceId, candidates, onSourceChange,
  onCountsUpdate, onSmoothedUpdate,
}: PumpFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Ring buffer of the last SMOOTH_WINDOW per-tick counts. Lives in a
  // ref so a slider change doesn't reset the average mid-clip.
  const historyRef = useRef<CountState[]>([]);

  const [detections, setDetections] = useState<OverlayDetection[]>([]);
  const [detectorStatus, setDetectorStatus] = useState<string>("");
  const [detectorError, setDetectorError] = useState<string | null>(null);
  // Per-class confidence floors. Bagged nozzles need a lower floor than
  // active ones because a partially-tied bag is genuinely harder for
  // Claude to call than a clean, unobstructed handle. Refs let the tick
  // read the latest values without rebuilding itself each slider drag.
  const [baggedConf, setBaggedConf] = useState(DEFAULT_CONF_BAGGED);
  const [activeConf, setActiveConf] = useState(DEFAULT_CONF_ACTIVE);
  const baggedConfRef = useRef(baggedConf);
  const activeConfRef = useRef(activeConf);
  useEffect(() => { baggedConfRef.current = baggedConf; }, [baggedConf]);
  useEffect(() => { activeConfRef.current = activeConf; }, [activeConf]);

  const sample = useMemo(() => getSampleVideo(sourceId) ?? null, [sourceId]);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
    playbackRate: VISION_PLAYBACK_RATE,
  });

  // Wipe history + bboxes when the source changes so the next clip
  // starts from a clean slate. The page-level state reset clears the
  // summary cards in parallel.
  useEffect(() => {
    historyRef.current = [];
    setDetections([]);
  }, [sourceId]);

  // Detector tick: capture one frame, run bagged + active in parallel,
  // update overlay + smoothed counters. useDetectionLoop's in-flight
  // guard means we never stack a second request on top of an in-progress
  // one - important because cold Claude calls can take 1-2 s and the
  // page ticks every second.
  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const frame = await captureVideoFrameForDetection(video);
    if (!frame) return;
    try {
      const [baggedResult, activeResult] = await Promise.all([
        callDetector(frame.image, { model: "pump_bagged", conf: baggedConfRef.current, fingerprint: frame.fingerprint })
          .catch(() => ({ detections: [], saved: null })),
        callDetector(frame.image, { model: "pump_active", conf: activeConfRef.current, fingerprint: frame.fingerprint })
          .catch(() => ({ detections: [], saved: null })),
      ]);
      const baggedBoxes: OverlayDetection[] = baggedResult.detections.map((d) => ({
        ...d,
        bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        kind: "bagged",
      }));
      const activeBoxes: OverlayDetection[] = activeResult.detections.map((d) => ({
        ...d,
        bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        kind: "active",
      }));
      setDetections([...baggedBoxes, ...activeBoxes]);
      setDetectorError(null);

      const liveCounts: CountState = {
        bagged: baggedBoxes.length,
        active: activeBoxes.length,
      };
      onCountsUpdate(liveCounts);

      const history = historyRef.current;
      history.push(liveCounts);
      while (history.length > SMOOTH_WINDOW) history.shift();
      const baggedAvg = history.reduce((a, c) => a + c.bagged, 0) / history.length;
      const activeAvg = history.reduce((a, c) => a + c.active, 0) / history.length;
      onSmoothedUpdate({
        bagged: Math.round(baggedAvg),
        active: Math.round(activeAvg),
      });

      const parts: string[] = [];
      if (liveCounts.bagged > 0) parts.push(`${liveCounts.bagged} bagged`);
      if (liveCounts.active > 0) parts.push(`${liveCounts.active} active`);
      setDetectorStatus(parts.length > 0 ? `Detected ${parts.join(" + ")}` : "Watching forecourt...");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDetectorError(message);
      setDetectorStatus("Detector unavailable");
    }
  }, [onCountsUpdate, onSmoothedUpdate]);

  useDetectionLoop({ isActive, intervalMs: TICK_INTERVAL_MS, tick });

  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => {
        const isBagged = d.kind === "bagged";
        return {
          bbox: d.bbox,
          color: isBagged ? COLOR_BAGGED : COLOR_ACTIVE,
          label: isBagged
            ? `BAGGED ${(d.confidence * 100).toFixed(0)}%`
            : `ACTIVE ${(d.confidence * 100).toFixed(0)}%`,
          fillAlpha: 0.14,
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
          <Label htmlFor="pump-status-source">Source</Label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id="pump-status-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Forecourt clips</SelectLabel>
                {candidates.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ThresholdSlider
            id="bagged-threshold"
            label="Bagged threshold"
            color={COLOR_BAGGED}
            value={baggedConf}
            onChange={setBaggedConf}
          />
          <ThresholdSlider
            id="active-threshold"
            label="Active threshold"
            color={COLOR_ACTIVE}
            value={activeConf}
            onChange={setActiveConf}
          />
        </div>

        <div
          className="relative bg-black rounded-lg overflow-hidden"
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
        </div>

        <div className="flex items-center gap-1.5 text-xs text-slate-500 justify-end">
          {videoStatus.kind === "loading" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          <Fuel className="w-3 h-3 shrink-0" style={{ color: COLOR_BAGGED }} />
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

interface ThresholdSliderProps {
  id: string;
  label: string;
  color: string;
  value: number;
  onChange: (value: number) => void;
}

function ThresholdSlider({ id, label, color, value, onChange }: ThresholdSliderProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs text-slate-600">{label}</Label>
        <span className="text-xs font-mono tabular-nums" style={{ color }}>
          {value.toFixed(2)}
        </span>
      </div>
      <Slider
        id={id}
        min={0}
        max={1}
        step={0.05}
        value={[value]}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
    </div>
  );
}
