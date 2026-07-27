import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue, Slider,
} from "@databricks/appkit-ui/react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Beer, Loader2 } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { formatBucketLabel } from "../lib/format";
import { SAMPLE_VIDEOS, VISION_PLAYBACK_RATE, getSampleVideo } from "../lib/samples";
import { useBatchFlush } from "../lib/useBatchFlush";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { usePollingEffect } from "../lib/usePollingEffect";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";

// Beverage page.
//
// A bar/table-service camera classifies every beer glass in frame by how
// much is left: full, half, or low. All three come from ONE Claude vision
// call per frame - the page fires /api/detect three times in parallel
// (model=beer_full / beer_half / beer_low) and the 2nd + 3rd hits land on
// the image-fingerprint cache because the trio registers identical `labels`
// + `promptAddendum` in server/server.ts VISION_GROUPS.
//
// Each bucket maps to a representative fill percentage so the operator sees
// a single "average fill" gauge and, more importantly, a live count of
// glasses running low (the refill candidates). Per-tick per-bucket counts
// are flushed to Lakebase so the dashboard chart can tally fill levels over
// time straight back out of Postgres - the same persistence path the Guests
// page uses for guest counts.

const FEED_FPS = 1.0;
const TICK_INTERVAL_MS = Math.round(1000 / FEED_FPS);

// Rolling window for the summary cards so a single frame where Claude
// miscounts one glass doesn't make the live numbers jitter.
const SMOOTH_WINDOW = 3;

// Lakebase flush + chart cadence, mirrored from the Guests page.
const POST_INTERVAL_MS = 5_000;
const CHART_REFRESH_MS = 5_000;
const CHART_WINDOW_SEC = 600;
const CHART_BUCKET_SEC = 30;

type FillKey = "full" | "half" | "low";

interface FillBucket {
  key: FillKey;
  /** LensIQ model id driving this bucket (see client/src/lib/models.ts). */
  model: string;
  label: string;
  color: string;
  /** Representative fill percentage used for the average-fill gauge + overlay. */
  pct: number;
  /** Per-class confidence floor - low glasses are harder to call than full ones. */
  defaultConf: number;
}

// Buckets ordered fullest -> emptiest. Colors match the model registry.
const FILL_BUCKETS: FillBucket[] = [
  { key: "full", model: "beer_full", label: "Full",  color: "#16a34a", pct: 85, defaultConf: 0.45 },
  { key: "half", model: "beer_half", label: "Half",  color: "#f59e0b", pct: 50, defaultConf: 0.4 },
  { key: "low",  model: "beer_low",  label: "Low",   color: "#dc2626", pct: 15, defaultConf: 0.4 },
];

type CountState = Record<FillKey, number>;

const EMPTY_COUNTS: CountState = { full: 0, half: 0, low: 0 };

function _totalGlasses(counts: CountState): number {
  return counts.full + counts.half + counts.low;
}

// Weighted average fill percentage across every glass in frame. Returns 0
// when no glasses are visible so the card reads "0%" instead of NaN.
function _avgFill(counts: CountState): number {
  const total = _totalGlasses(counts);
  if (total <= 0) return 0;
  const weighted = FILL_BUCKETS.reduce((sum, b) => sum + counts[b.key] * b.pct, 0);
  return Math.round(weighted / total);
}

interface BeveragePageProps {
  isActive: boolean;
}

interface RecentRow {
  fill_bucket: string;
  bucket_ts: string;
  avg_count: number;
  max_count: number;
}

interface ChartRow {
  ts: number;
  label: string;
  full: number | null;
  half: number | null;
  low: number | null;
}

interface PendingFill {
  source_id: string;
  fill_bucket: FillKey;
  glass_count: number;
}

export function BeveragePage({ isActive }: BeveragePageProps) {
  // Default to the dedicated bar montage. Fall back to the first sample that
  // lists any beer model if the canonical id is ever renamed.
  const [sourceId, setSourceId] = useState(() => {
    const preferred = getSampleVideo("bar-table-montage");
    if (preferred) return preferred.id;
    const fallback = SAMPLE_VIDEOS.find((s) =>
      FILL_BUCKETS.some((b) => s.models.includes(b.model)),
    );
    return fallback?.id ?? "bar-table-montage";
  });
  const [live, setLive] = useState<CountState>(EMPTY_COUNTS);
  const [smoothed, setSmoothed] = useState<CountState>(EMPTY_COUNTS);
  const [peakLow, setPeakLow] = useState(0);
  const [chartRows, setChartRows] = useState<ChartRow[]>([]);

  // Curated source list: every sample that carries any beer model. Keeps the
  // dropdown self-maintaining as new bar clips get added to ./samples.ts.
  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter((s) => FILL_BUCKETS.some((b) => s.models.includes(b.model))),
    [],
  );

  const pendingRef = useBatchFlush<PendingFill>({
    isActive,
    endpoint: "/api/beer-fills",
    intervalMs: POST_INTERVAL_MS,
  });

  const handleCountsUpdate = useCallback((tick: CountState) => {
    setLive(tick);
    setPeakLow((cur) => Math.max(cur, tick.low));
    // Queue one row per fill bucket for the Lakebase flush so the dashboard
    // chart can re-aggregate fill levels over time.
    for (const b of FILL_BUCKETS) {
      pendingRef.current.push({ source_id: sourceId, fill_bucket: b.key, glass_count: tick[b.key] });
    }
  }, [sourceId, pendingRef]);

  const handleSmoothedUpdate = useCallback((avg: CountState) => {
    setSmoothed(avg);
  }, []);

  // Reset peak/live when the operator switches clips so a peak from a
  // busy table doesn't stick around on a quiet one.
  useEffect(() => {
    setPeakLow(0);
    setLive(EMPTY_COUNTS);
    setSmoothed(EMPTY_COUNTS);
  }, [sourceId]);

  const loadChart = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/beer-fills/recent?windowSec=${CHART_WINDOW_SEC}&bucketSec=${CHART_BUCKET_SEC}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { rows: RecentRow[] };
      const grouped = new Map<string, ChartRow>();
      for (const row of body.rows) {
        const ts = new Date(row.bucket_ts).getTime();
        const key = String(ts);
        const existing = grouped.get(key) ?? {
          ts,
          label: formatBucketLabel(ts),
          full: null,
          half: null,
          low: null,
        };
        if (row.fill_bucket === "full") existing.full = row.avg_count;
        else if (row.fill_bucket === "half") existing.half = row.avg_count;
        else if (row.fill_bucket === "low") existing.low = row.avg_count;
        grouped.set(key, existing);
      }
      const sorted = Array.from(grouped.values()).sort((a, b) => a.ts - b.ts);
      setChartRows(sorted);
    } catch {
      // Chart is purely informational - keep the feed running.
    }
  }, []);

  usePollingEffect(loadChart, { isActive, intervalMs: CHART_REFRESH_MS });

  const totalNow = _totalGlasses(smoothed);
  const avgFill = _avgFill(smoothed);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Glasses in frame</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{totalNow}</span>
              <span className="text-xs text-slate-500">smoothed (3 s)</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Average fill</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: avgFill < 33 ? "#dc2626" : avgFill < 66 ? "#f59e0b" : "#16a34a" }}
              >
                {avgFill}%
              </span>
              <span className="text-xs text-slate-500">across glasses in frame</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Running low</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-semibold tabular-nums"
                style={{ color: smoothed.low > 0 ? "#dc2626" : "#0f172a" }}
              >
                {smoothed.low}
              </span>
              <span className="text-xs text-slate-500">need a refill</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Peak low this clip</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{peakLow}</span>
              <span className="text-xs" style={{ color: "#dc2626" }}>refill spike</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <BeverageFeed
            isActive={isActive}
            sourceId={sourceId}
            candidates={candidates}
            live={live}
            onSourceChange={setSourceId}
            onCountsUpdate={handleCountsUpdate}
            onSmoothedUpdate={handleSmoothedUpdate}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Why this matters</CardTitle>
            <CardDescription>
              Refill prompts at a glance, from one Claude vision call.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm text-slate-700">
              <p>
                Each tick the page captures one frame from the table cam
                and runs three `/api/detect` calls in parallel:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-slate-600">
                {FILL_BUCKETS.map((b) => (
                  <li key={b.key}>
                    <span className="font-medium" style={{ color: b.color }}>{b.model}</span>
                    {" "}counts glasses about <strong>{b.pct}%</strong> full.
                  </li>
                ))}
              </ul>
              <p>
                All three share the same labels and prompt, so the 2nd and
                3rd calls hit the image-fingerprint cache and the whole trio
                costs <strong>one</strong> Claude round-trip per frame. A
                Lakebase L2 cache keeps the loop instant across restarts.
              </p>
              <p>
                Per-tick counts are written to Lakebase Postgres, so the
                dashboard below tallies fill levels over time straight back
                out of the database - staff can see refill demand build.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Beverage fill levels over time</CardTitle>
          <CardDescription>
            Average glasses per fill level over the last {Math.round(CHART_WINDOW_SEC / 60)} minutes, tallied from Lakebase.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            {chartRows.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500">
                Waiting for the first glasses to be detected...
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartRows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} width={32} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12, padding: "4px 8px" }} labelFormatter={(v) => `t=${v}`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {FILL_BUCKETS.map((b) => (
                    <Line
                      key={b.key}
                      type="monotone"
                      dataKey={b.key}
                      name={b.label}
                      stroke={b.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface BeverageFeedProps {
  isActive: boolean;
  sourceId: string;
  candidates: typeof SAMPLE_VIDEOS;
  live: CountState;
  onSourceChange: (id: string) => void;
  onCountsUpdate: (counts: CountState) => void;
  onSmoothedUpdate: (counts: CountState) => void;
}

interface OverlayDetection extends Detection {
  bucket: FillBucket;
}

function BeverageFeed({
  isActive, sourceId, candidates, live, onSourceChange,
  onCountsUpdate, onSmoothedUpdate,
}: BeverageFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Ring buffer of the last SMOOTH_WINDOW per-tick counts. Lives in a ref so
  // a slider change doesn't reset the average mid-clip.
  const historyRef = useRef<CountState[]>([]);

  const [detections, setDetections] = useState<OverlayDetection[]>([]);
  const [detectorStatus, setDetectorStatus] = useState<string>("");
  const [detectorError, setDetectorError] = useState<string | null>(null);

  // Per-class confidence floors. Refs let the tick read the latest values
  // without rebuilding itself on every slider drag.
  const [confs, setConfs] = useState<Record<FillKey, number>>(() =>
    Object.fromEntries(FILL_BUCKETS.map((b) => [b.key, b.defaultConf])) as Record<FillKey, number>,
  );
  const confsRef = useRef(confs);
  useEffect(() => { confsRef.current = confs; }, [confs]);

  const sample = useMemo(() => getSampleVideo(sourceId) ?? null, [sourceId]);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
    playbackRate: VISION_PLAYBACK_RATE,
  });

  // Wipe history + bboxes when the source changes so the next clip starts
  // from a clean slate. The page-level reset clears the summary cards.
  useEffect(() => {
    historyRef.current = [];
    setDetections([]);
  }, [sourceId]);

  // Detector tick: capture one frame, run all three fill models in parallel,
  // update overlay + smoothed counters. useDetectionLoop's in-flight guard
  // means we never stack a second request on an in-progress one.
  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const frame = await captureVideoFrameForDetection(video);
    if (!frame) return;
    try {
      const results = await Promise.all(
        FILL_BUCKETS.map((b) =>
          callDetector(frame.image, {
            model: b.model,
            conf: confsRef.current[b.key],
            fingerprint: frame.fingerprint,
          }).catch(() => ({ detections: [], saved: null })),
        ),
      );

      const boxes: OverlayDetection[] = [];
      const liveCounts: CountState = { ...EMPTY_COUNTS };
      FILL_BUCKETS.forEach((b, i) => {
        const dets = results[i]?.detections ?? [];
        liveCounts[b.key] = dets.length;
        for (const d of dets) {
          boxes.push({ ...d, bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY), bucket: b });
        }
      });

      setDetections(boxes);
      setDetectorError(null);
      onCountsUpdate(liveCounts);

      const history = historyRef.current;
      history.push(liveCounts);
      while (history.length > SMOOTH_WINDOW) history.shift();
      const avg: CountState = { ...EMPTY_COUNTS };
      for (const b of FILL_BUCKETS) {
        avg[b.key] = Math.round(
          history.reduce((a, c) => a + c[b.key], 0) / history.length,
        );
      }
      onSmoothedUpdate(avg);

      const parts = FILL_BUCKETS
        .filter((b) => liveCounts[b.key] > 0)
        .map((b) => `${liveCounts[b.key]} ${b.label.toLowerCase()}`);
      setDetectorStatus(parts.length > 0 ? `Detected ${parts.join(" + ")}` : "Watching the table...");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDetectorError(message);
      setDetectorStatus("Detector unavailable");
    }
  }, [onCountsUpdate, onSmoothedUpdate]);

  useDetectionLoop({ isActive, intervalMs: TICK_INTERVAL_MS, tick });

  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => ({
        bbox: d.bbox,
        color: d.bucket.color,
        label: `${d.bucket.label.toUpperCase()} ~${d.bucket.pct}%`,
        fillAlpha: 0.14,
        labelAlpha: 1,
      })),
    [detections],
  );

  useEffect(() => {
    drawBboxOverlay(canvasRef.current, videoRef.current, videoSize, overlayBoxes);
  }, [overlayBoxes, videoSize]);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="beverage-source">Source</Label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id="beverage-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Bar / table clips</SelectLabel>
                {candidates.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {FILL_BUCKETS.map((b) => (
            <ThresholdSlider
              key={b.key}
              id={`${b.key}-threshold`}
              label={`${b.label} threshold`}
              color={b.color}
              value={confs[b.key]}
              onChange={(v) => setConfs((prev) => ({ ...prev, [b.key]: v }))}
            />
          ))}
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
          <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
            {FILL_BUCKETS.map((b) => (
              <span
                key={b.key}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium backdrop-blur bg-white/85"
                style={{ color: b.color }}
              >
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: b.color }} />
                {b.label} {live[b.key]}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-slate-500 justify-end">
          {videoStatus.kind === "loading" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          <Beer className="w-3 h-3 shrink-0" style={{ color: "#f59e0b" }} />
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
