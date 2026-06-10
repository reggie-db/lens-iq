import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from "@databricks/appkit-ui/react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { formatBucketLabel } from "../lib/format";
import { SAMPLE_VIDEOS, getSampleVideo } from "../lib/samples";
import { useBatchFlush } from "../lib/useBatchFlush";
import { usePollingEffect } from "../lib/usePollingEffect";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";

// Guest count view.
//
// Two CCTV feeds run YOLO in parallel. We split each detection into one of
// three logical metrics:
//   - pump_users : people on the forecourt feed
//   - pump_cars  : cars/trucks/buses/motorcycles on the forecourt feed
//   - in_store   : people on the c-store interior feed
//
// Tallies are cumulative across the session via a simple centroid tracker per
// feed: a new detection only bumps the cumulative count when it doesn't match
// any active track (i.e., it's a new object). Matched detections refresh the
// existing track's last-seen tick. Tracks expire after TRACK_TTL_TICKS misses
// so a brief detector miss doesn't double-count when the object reappears.
//
// Per-tick instantaneous counts are POSTed to Lakebase every POST_INTERVAL_MS
// so the time-series chart can show activity history coming straight back out
// of Postgres - proves the persistence path end to end.

const FEED_FPS = 1;
const POST_INTERVAL_MS = 5_000;
const CHART_REFRESH_MS = 5_000;
const CHART_WINDOW_SEC = 600;
const CHART_BUCKET_SEC = 30;

// Centroid tracking thresholds. A detection is "the same object" as an
// existing track if its centroid is within MATCH_FRACTION of the larger
// video dimension. Tracks that go un-updated for TRACK_TTL_TICKS consecutive
// ticks expire so the next sighting starts a fresh track.
const MATCH_FRACTION = 0.18;
const TRACK_TTL_TICKS = 4;

const VEHICLE_LABELS = new Set(["car", "truck", "bus", "motorcycle"]);

const METRIC_PUMP_USERS = "pump_users";
const METRIC_PUMP_CARS = "pump_cars";
const METRIC_IN_STORE = "in_store";

const COLOR_PUMP_USERS = "#0ea5e9";
const COLOR_PUMP_CARS = "#a855f7";
const COLOR_IN_STORE = "#10b981";

interface ClassTracker {
  metric: string;
  cardLabel: string;
  color: string;
  /** YOLO labels that count as this class. */
  yoloLabels: Set<string>;
}

const PUMP_CLASSES: ClassTracker[] = [
  { metric: METRIC_PUMP_USERS, cardLabel: "Pump users", color: COLOR_PUMP_USERS, yoloLabels: new Set(["person"]) },
  { metric: METRIC_PUMP_CARS, cardLabel: "Pump cars", color: COLOR_PUMP_CARS, yoloLabels: VEHICLE_LABELS },
];

const IN_STORE_CLASSES: ClassTracker[] = [
  { metric: METRIC_IN_STORE, cardLabel: "In-store", color: COLOR_IN_STORE, yoloLabels: new Set(["person"]) },
];

interface GuestsPageProps {
  isActive: boolean;
}

interface RecentRow {
  zone: string;
  bucket_ts: string;
  avg_count: number;
  max_count: number;
}

interface ChartRow {
  ts: number;
  label: string;
  [METRIC_PUMP_USERS]: number | null;
  [METRIC_PUMP_CARS]: number | null;
  [METRIC_IN_STORE]: number | null;
}

interface FeedSample {
  current: Record<string, number>;
  newTracks: Record<string, number>;
}

interface PendingCount {
  source_id: string;
  zone: string;
  person_count: number;
}

export function GuestsPage({ isActive }: GuestsPageProps) {
  const [pumpSource, setPumpSource] = useState("forecourt-essar");
  const [inStoreSource, setInStoreSource] = useState("cstore-interior");
  const [current, setCurrent] = useState<Record<string, number>>({
    [METRIC_PUMP_USERS]: 0,
    [METRIC_PUMP_CARS]: 0,
    [METRIC_IN_STORE]: 0,
  });
  const [cumulative, setCumulative] = useState<Record<string, number>>({
    [METRIC_PUMP_USERS]: 0,
    [METRIC_PUMP_CARS]: 0,
    [METRIC_IN_STORE]: 0,
  });
  const [chartRows, setChartRows] = useState<ChartRow[]>([]);

  const pumpSources = useMemo(
    () => SAMPLE_VIDEOS.filter((s) => s.models.includes("license_plate")),
    [],
  );
  const inStoreSources = useMemo(
    () =>
      SAMPLE_VIDEOS.filter(
        (s) =>
          s.models.includes("people_count") ||
          s.id === "cstore-interior" ||
          s.id === "qsr-cafe-cctv",
      ),
    [],
  );

  const pendingRef = useBatchFlush<PendingCount>({
    isActive,
    endpoint: "/api/guest-counts",
    intervalMs: POST_INTERVAL_MS,
  });

  // Each feed reports per-tick. We update instantaneous current counts and
  // bump cumulative by the number of new tracks seen. We also queue an
  // instantaneous row per metric for the Lakebase POST so the chart still
  // shows per-bucket activity instead of monotonic cumulative.
  const handleSample = useCallback(
    (sourceId: string, sample: FeedSample) => {
      setCurrent((prev) => ({ ...prev, ...sample.current }));
      setCumulative((prev) => {
        const next = { ...prev };
        for (const [metric, n] of Object.entries(sample.newTracks)) {
          next[metric] = (next[metric] ?? 0) + n;
        }
        return next;
      });
      for (const [metric, n] of Object.entries(sample.current)) {
        pendingRef.current.push({ source_id: sourceId, zone: metric, person_count: n });
      }
    },
    [],
  );

  const loadChart = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/guest-counts/recent?windowSec=${CHART_WINDOW_SEC}&bucketSec=${CHART_BUCKET_SEC}`,
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
          [METRIC_PUMP_USERS]: null,
          [METRIC_PUMP_CARS]: null,
          [METRIC_IN_STORE]: null,
        };
        if (row.zone === METRIC_PUMP_USERS) existing[METRIC_PUMP_USERS] = row.avg_count;
        else if (row.zone === METRIC_PUMP_CARS) existing[METRIC_PUMP_CARS] = row.avg_count;
        else if (row.zone === METRIC_IN_STORE) existing[METRIC_IN_STORE] = row.avg_count;
        grouped.set(key, existing);
      }
      const sorted = Array.from(grouped.values()).sort((a, b) => a.ts - b.ts);
      setChartRows(sorted);
    } catch {
      // Chart is purely informational - keep the feeds running.
    }
  }, []);

  usePollingEffect(loadChart, { isActive, intervalMs: CHART_REFRESH_MS });

  // Total guests = humans only. Cars are tracked separately - cars-as-guests
  // would double-count people who are also visible at the pump.
  const currentGuests = (current[METRIC_PUMP_USERS] ?? 0) + (current[METRIC_IN_STORE] ?? 0);
  const totalGuests = (cumulative[METRIC_PUMP_USERS] ?? 0) + (cumulative[METRIC_IN_STORE] ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-kiosk="guest-counts">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Guests on premises</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{currentGuests}</span>
              <span className="text-xs text-slate-500">right now</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-0.5">Total guests seen</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{totalGuests}</span>
              <span className="text-xs text-slate-500">this session</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ZoneCard label="Pump users" color={COLOR_PUMP_USERS} current={current[METRIC_PUMP_USERS] ?? 0} cumulative={cumulative[METRIC_PUMP_USERS] ?? 0} unit="person" />
        <ZoneCard label="Pump cars"  color={COLOR_PUMP_CARS}  current={current[METRIC_PUMP_CARS] ?? 0}  cumulative={cumulative[METRIC_PUMP_CARS] ?? 0}  unit="vehicle" />
        <ZoneCard label="In-store"   color={COLOR_IN_STORE}   current={current[METRIC_IN_STORE] ?? 0}   cumulative={cumulative[METRIC_IN_STORE] ?? 0}   unit="person" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GuestFeed
          isActive={isActive}
          zoneLabel="Forecourt"
          sourceId={pumpSource}
          candidateSources={pumpSources}
          classes={PUMP_CLASSES}
          onSourceChange={setPumpSource}
          onSample={handleSample}
        />
        <GuestFeed
          isActive={isActive}
          zoneLabel="C-store"
          sourceId={inStoreSource}
          candidateSources={inStoreSources}
          classes={IN_STORE_CLASSES}
          onSourceChange={setInStoreSource}
          onSample={handleSample}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Guest traffic over time</CardTitle>
          <CardDescription>
            Average people and vehicles per zone over the last {Math.round(CHART_WINDOW_SEC / 60)} minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            {chartRows.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500">
                Waiting for the first guests to be detected...
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartRows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} width={32} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12, padding: "4px 8px" }} labelFormatter={(v) => `t=${v}`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey={METRIC_PUMP_USERS} name="Pump users" stroke={COLOR_PUMP_USERS} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={METRIC_PUMP_CARS}  name="Pump cars"  stroke={COLOR_PUMP_CARS}  strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={METRIC_IN_STORE}   name="In-store"   stroke={COLOR_IN_STORE}   strokeWidth={2} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ZoneCard({ label, color, current, cumulative, unit }: { label: string; color: string; current: number; cumulative: number; unit: string }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-500 mb-0.5">
          <span>{label}</span>
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums" style={{ color }}>{cumulative}</span>
          <span className="text-xs text-slate-500">total</span>
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {current} {unit}{current === 1 ? "" : "s"} right now
        </div>
      </CardContent>
    </Card>
  );
}

interface GuestFeedProps {
  isActive: boolean;
  zoneLabel: string;
  sourceId: string;
  candidateSources: typeof SAMPLE_VIDEOS;
  classes: ClassTracker[];
  onSourceChange: (id: string) => void;
  onSample: (sourceId: string, sample: FeedSample) => void;
}

interface Track {
  id: number;
  metric: string;
  bbox: [number, number, number, number];
  centerX: number;
  centerY: number;
  lastSeenTick: number;
}

// One CCTV feed. Filters YOLO detections into one or more class buckets,
// runs a centroid tracker per bucket, and reports both the instantaneous
// count and the number of *new* tracks (cumulative-delta) back upstream.
function GuestFeed({
  isActive,
  zoneLabel,
  sourceId,
  candidateSources,
  classes,
  onSourceChange,
  onSample,
}: GuestFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inFlightRef = useRef(false);
  const tracksRef = useRef<Track[]>([]);
  const tickIdxRef = useRef(0);
  const nextTrackIdRef = useRef(1);
  const [detections, setDetections] = useState<Array<Detection & { metric: string; color: string }>>([]);
  const [detectorStatus, setDetectorStatus] = useState<string>("");

  const sample = useMemo(() => getSampleVideo(sourceId) ?? null, [sourceId]);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
  });

  // Reset tracker state when the source changes - tracks from one clip
  // shouldn't carry over and accidentally match objects in the next.
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
        // Categorize each detection into one of our class buckets. Drop
        // anything that doesn't match (e.g. forecourt feed sees a "bird" -
        // we don't care about that here).
        const categorized = result.detections
          .map((d) => {
            const cls = classes.find((c) => c.yoloLabels.has(d.label));
            if (!cls) return null;
            const bbox = scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY);
            return { ...d, bbox, metric: cls.metric, color: cls.color };
          })
          .filter((d): d is Detection & { metric: string; color: string } => d !== null);

        setDetections(categorized);

        // Match against existing tracks per metric. A match (same metric,
        // centroid within threshold) refreshes the track. A miss adds a new
        // track and contributes to the cumulative count for that metric.
        const threshold = MATCH_FRACTION * Math.max(frame.scaleX > 0 ? video.videoWidth : 1280, frame.scaleY > 0 ? video.videoHeight : 720);
        const newTracks: Record<string, number> = {};
        const current: Record<string, number> = {};
        for (const c of classes) {
          newTracks[c.metric] = 0;
          current[c.metric] = 0;
        }

        const claimed = new Set<number>();
        for (const det of categorized) {
          const [x1, y1, x2, y2] = det.bbox;
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          let best: Track | null = null;
          let bestDist = Infinity;
          for (const t of tracksRef.current) {
            if (t.metric !== det.metric) continue;
            if (claimed.has(t.id)) continue;
            const dx = t.centerX - cx;
            const dy = t.centerY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < threshold && dist < bestDist) {
              best = t;
              bestDist = dist;
            }
          }
          if (best) {
            best.bbox = det.bbox;
            best.centerX = cx;
            best.centerY = cy;
            best.lastSeenTick = tickIdx;
            claimed.add(best.id);
          } else {
            tracksRef.current.push({
              id: nextTrackIdRef.current++,
              metric: det.metric,
              bbox: det.bbox,
              centerX: cx,
              centerY: cy,
              lastSeenTick: tickIdx,
            });
            newTracks[det.metric] = (newTracks[det.metric] ?? 0) + 1;
          }
          current[det.metric] = (current[det.metric] ?? 0) + 1;
        }

        // Expire stale tracks so a brief detector miss doesn't double-count
        // an object that reappears a frame later.
        tracksRef.current = tracksRef.current.filter((t) => tickIdx - t.lastSeenTick <= TRACK_TTL_TICKS);

        onSample(sourceId, { current, newTracks });
        const totalCurrent = Object.values(current).reduce((a, b) => a + b, 0);
        setDetectorStatus(totalCurrent > 0 ? `Counted ${totalCurrent} object(s)` : "Watching for activity...");
      } catch (err) {
        setDetectorStatus(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
      }
    };
    const id = setInterval(tick, 1000 / FEED_FPS);
    return () => clearInterval(id);
  }, [isActive, onSample, sourceId, classes]);

  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => ({
        bbox: d.bbox,
        color: d.color,
        label: `${d.label} ${(d.confidence * 100).toFixed(0)}%`,
        fillAlpha: 0,
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
          <Label htmlFor={`source-${zoneLabel}`}>{zoneLabel} source</Label>
          <Select value={sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id={`source-${zoneLabel}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Sample clips</SelectLabel>
                {candidateSources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
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
          <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
            {classes.map((c) => (
              <Badge
                key={c.metric}
                variant="outline"
                className="gap-1.5 backdrop-blur bg-white/85"
                style={{ borderColor: c.color, color: c.color }}
              >
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
                {c.cardLabel}
              </Badge>
            ))}
          </div>
        </div>
        <div className="text-xs text-slate-500 break-words">
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

