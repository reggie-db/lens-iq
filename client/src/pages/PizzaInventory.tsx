import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue, Slider,
} from "@databricks/appkit-ui/react";
import { AlertTriangle, Loader2, Pizza } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { SAMPLE_VIDEOS, getSampleVideo } from "../lib/samples";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";

// Pizza Inventory page.
//
// One CV-driven counter for a pizza station: how many ready-to-grab
// slices are on the board right now, and how many whole uncut pies are
// staged behind them. Both numbers come from a single Claude vision
// call per frame on the shared `llm` Model Serving alias - the page
// calls /api/detect twice in parallel (model=pizza_inventory for
// slices, model=pizza_pie for whole pies) and the second call hits the
// image-hash cache because both models register identical `labels` +
// `promptAddendum` in server/server.ts VISION_GROUPS.
//
// The summary cards average over the last N detector ticks instead of
// snapping to the latest frame so a single frame where Claude misses a
// half-occluded slice doesn't make the live count jitter. The bbox
// overlay still renders the latest frame's detections so a presenter
// can point and say "see, two whole pies left, four slices ready".

const FEED_FPS = 1.0;
const TICK_INTERVAL_MS = Math.round(1000 / FEED_FPS);

const DEFAULT_CONF_SLICE = 0.4;
const DEFAULT_CONF_PIE = 0.6;

// Rolling window for the "available slices" and "whole pies" cards.
// Three ticks at 1 fps = 3 s, enough to ride through a one-frame miss
// without lagging the presenter behind reality.
const SMOOTH_WINDOW = 3;

const COLOR_SLICE = "#b91c1c";
const COLOR_PIE = "#f59e0b";

interface PizzaInventoryPageProps {
  isActive: boolean;
}

interface CountState {
  slices: number;
  pies: number;
}

const EMPTY_COUNTS: CountState = { slices: 0, pies: 0 };

export function PizzaInventoryPage({ isActive }: PizzaInventoryPageProps) {
  // Default to the dedicated counter clip. Fall back to the first
  // pizza-tagged sample if the canonical id is ever renamed.
  const [sourceId, setSourceId] = useState(() => {
    const preferred = getSampleVideo("pizza-slice-inventory");
    if (preferred) return preferred.id;
    const fallback = SAMPLE_VIDEOS.find(
      (s) => s.models.includes("pizza_inventory") || s.models.includes("pizza_pie"),
    );
    return fallback?.id ?? "pizza-slice-inventory";
  });
  const [live, setLive] = useState<CountState>(EMPTY_COUNTS);
  const [smoothed, setSmoothed] = useState<CountState>(EMPTY_COUNTS);
  const [peak, setPeak] = useState<CountState>(EMPTY_COUNTS);

  // Curated source list: every sample that carries either pizza model
  // in its `models` array. Keeps the dropdown self-maintaining as new
  // pizza clips get added to ./samples.ts.
  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter(
      (s) => s.models.includes("pizza_inventory") || s.models.includes("pizza_pie"),
    ),
    [],
  );

  const handleCountsUpdate = useCallback((tick: CountState) => {
    setLive(tick);
    setPeak((cur) => ({
      slices: Math.max(cur.slices, tick.slices),
      pies: Math.max(cur.pies, tick.pies),
    }));
  }, []);

  const handleSmoothedUpdate = useCallback((avg: CountState) => {
    setSmoothed(avg);
  }, []);

  // Reset peak when the operator switches clips - a peak from a busy
  // dinner-rush clip would otherwise stick around when they swap to a
  // quiet morning clip.
  useEffect(() => {
    setPeak(EMPTY_COUNTS);
    setLive(EMPTY_COUNTS);
    setSmoothed(EMPTY_COUNTS);
  }, [sourceId]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Slices ready</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: COLOR_SLICE }}
              >
                {smoothed.slices}
              </span>
              <span className="text-xs text-slate-500">smoothed (3 s window)</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Whole pies staged</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: COLOR_PIE }}
              >
                {smoothed.pies}
              </span>
              <span className="text-xs text-slate-500">smoothed (3 s window)</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Last frame</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">
                {live.slices}
              </span>
              <span className="text-xs" style={{ color: COLOR_SLICE }}>slices</span>
              <span className="text-3xl font-semibold tabular-nums text-slate-900">
                {live.pies}
              </span>
              <span className="text-xs" style={{ color: COLOR_PIE }}>pies</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Peak this clip</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">
                {peak.slices}
              </span>
              <span className="text-xs" style={{ color: COLOR_SLICE }}>slices</span>
              <span className="text-3xl font-semibold tabular-nums text-slate-900">
                {peak.pies}
              </span>
              <span className="text-xs" style={{ color: COLOR_PIE }}>pies</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PizzaFeed
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
              Hot-hold inventory at a glance, from one Claude vision call.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm text-slate-700">
              <p>
                Each tick the page captures a single frame from the
                counter cam and runs two `/api/detect` calls in
                parallel:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-slate-600">
                <li>
                  <span className="font-medium text-slate-900">pizza_inventory</span>
                  {" "}counts every individually-cut wedge currently on the board.
                </li>
                <li>
                  <span className="font-medium text-slate-900">pizza_pie</span>
                  {" "}counts every complete uncut pizza staged behind them.
                </li>
              </ul>
              <p>
                Both models share the same labels and prompt, so the
                second call hits the image-hash cache and the pair
                costs <strong>one</strong> Claude round-trip per frame.
              </p>
              <p>
                The "ready" cards smooth over a 3-second window so a
                single occluded frame won't fire a false low-stock
                alert. The bbox overlay still renders the latest frame
                so the count is auditable in real time.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface PizzaFeedProps {
  isActive: boolean;
  sourceId: string;
  candidates: typeof SAMPLE_VIDEOS;
  onSourceChange: (id: string) => void;
  onCountsUpdate: (counts: CountState) => void;
  onSmoothedUpdate: (counts: CountState) => void;
}

interface OverlayDetection extends Detection {
  kind: "slice" | "pie";
}

function PizzaFeed({
  isActive, sourceId, candidates, onSourceChange,
  onCountsUpdate, onSmoothedUpdate,
}: PizzaFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Ring buffer of the last SMOOTH_WINDOW per-tick counts. Lives in a
  // ref so a slider change doesn't reset the average mid-clip.
  const historyRef = useRef<CountState[]>([]);

  const [detections, setDetections] = useState<OverlayDetection[]>([]);
  const [detectorStatus, setDetectorStatus] = useState<string>("");
  const [detectorError, setDetectorError] = useState<string | null>(null);
  // Per-class confidence floors. Slices need a lower floor than whole
  // pies because Claude is genuinely less sure about partially-eaten
  // wedges than about full circular pizzas. Refs let the tick read
  // the latest values without rebuilding itself each slider drag.
  const [sliceConf, setSliceConf] = useState(DEFAULT_CONF_SLICE);
  const [pieConf, setPieConf] = useState(DEFAULT_CONF_PIE);
  const sliceConfRef = useRef(sliceConf);
  const pieConfRef = useRef(pieConf);
  useEffect(() => { sliceConfRef.current = sliceConf; }, [sliceConf]);
  useEffect(() => { pieConfRef.current = pieConf; }, [pieConf]);

  const sample = useMemo(() => getSampleVideo(sourceId) ?? null, [sourceId]);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
  });

  // Wipe history + bboxes when the source changes so the next clip
  // starts from a clean slate. The page-level state reset clears the
  // summary cards in parallel.
  useEffect(() => {
    historyRef.current = [];
    setDetections([]);
  }, [sourceId]);

  // Detector tick: capture one frame, run slice + pie in parallel,
  // update overlay + smoothed counters. useDetectionLoop's in-flight
  // guard means we never stack a second request on top of an in-progress
  // one - important because cold Claude calls can take 1-2 s and the
  // page ticks every second.
  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const frame = captureVideoFrameForDetection(video);
    if (!frame) return;
    try {
      const [sliceResult, pieResult] = await Promise.all([
        callDetector(frame.image, { model: "pizza_inventory", conf: sliceConfRef.current })
          .catch(() => ({ detections: [], saved: null })),
        callDetector(frame.image, { model: "pizza_pie", conf: pieConfRef.current })
          .catch(() => ({ detections: [], saved: null })),
      ]);
      const sliceBoxes: OverlayDetection[] = sliceResult.detections.map((d) => ({
        ...d,
        bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        kind: "slice",
      }));
      const pieBoxes: OverlayDetection[] = pieResult.detections.map((d) => ({
        ...d,
        bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        kind: "pie",
      }));
      setDetections([...sliceBoxes, ...pieBoxes]);
      setDetectorError(null);

      const liveCounts: CountState = {
        slices: sliceBoxes.length,
        pies: pieBoxes.length,
      };
      onCountsUpdate(liveCounts);

      const history = historyRef.current;
      history.push(liveCounts);
      while (history.length > SMOOTH_WINDOW) history.shift();
      const sliceAvg = history.reduce((a, c) => a + c.slices, 0) / history.length;
      const pieAvg = history.reduce((a, c) => a + c.pies, 0) / history.length;
      onSmoothedUpdate({
        slices: Math.round(sliceAvg),
        pies: Math.round(pieAvg),
      });

      const parts: string[] = [];
      if (liveCounts.slices > 0) parts.push(`${liveCounts.slices} slice${liveCounts.slices === 1 ? "" : "s"}`);
      if (liveCounts.pies > 0) parts.push(`${liveCounts.pies} pie${liveCounts.pies === 1 ? "" : "s"}`);
      setDetectorStatus(parts.length > 0 ? `Detected ${parts.join(" + ")}` : "Watching pizza station...");
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
        const isSlice = d.kind === "slice";
        return {
          bbox: d.bbox,
          color: isSlice ? COLOR_SLICE : COLOR_PIE,
          label: isSlice
            ? `SLICE ${(d.confidence * 100).toFixed(0)}%`
            : `PIE ${(d.confidence * 100).toFixed(0)}%`,
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
          <Label htmlFor="pizza-inventory-source">Source</Label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id="pizza-inventory-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Pizza station clips</SelectLabel>
                {candidates.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ThresholdSlider
            id="slice-threshold"
            label="Slice threshold"
            color={COLOR_SLICE}
            value={sliceConf}
            onChange={setSliceConf}
          />
          <ThresholdSlider
            id="pie-threshold"
            label="Whole-pie threshold"
            color={COLOR_PIE}
            value={pieConf}
            onChange={setPieConf}
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
          <Pizza className="w-3 h-3 shrink-0" style={{ color: COLOR_SLICE }} />
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
