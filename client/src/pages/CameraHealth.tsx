import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from "@databricks/appkit-ui/react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CloudFog, Eye, Loader2 } from "lucide-react";
import {
  captureVideoFrameForDetection,
  scaleDetectionBbox,
} from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { SAMPLE_VIDEOS, getSampleVideo, sampleVideoUrl } from "../lib/samples";

// Camera Health view.
//
// Two CCTV feeds run the `fog_detector` endpoint in parallel. The detector is
// a pure-Python PyFunc (Pillow + numpy) that tiles each frame into an 8x6
// grid, scores each patch's Laplacian variance (sharpness proxy) and mean
// brightness, and emits a bounding box for each connected fogged region. A
// `clear` baseline frame returns a single full-frame "clear" detection that
// we deliberately don't draw - only the fogged regions get highlighted.
//
// Per-tick observations are POSTed to Lakebase via /api/fog-observations so
// the chart can re-aggregate "% of frame fogged" per camera over time. This
// mirrors the guest_counts persistence pattern. The Lakebase table is
// auto-created lazily on first POST so the demo works on a fresh project.
//
// The page also tracks a client-side "incidents opened" counter per feed: a
// run of INCIDENT_TICK_THRESHOLD consecutive fogged ticks bumps the counter.
// Single-tick flickers don't get counted - the threshold debounces what would
// otherwise be ticket spam if the detector glances off a temporary
// reflection.

const FEED_FPS = 0.5;
const POST_INTERVAL_MS = 5_000;
const CHART_REFRESH_MS = 5_000;
const INCIDENTS_REFRESH_MS = 5_000;
const CHART_WINDOW_SEC = 600;
const CHART_BUCKET_SEC = 30;
const INCIDENTS_LIMIT = 25;

// Sustained-fog threshold (consecutive fogged ticks). Below this the UI
// shows "Spike" instead of "Fogged" and no incident is logged.
const INCIDENT_TICK_THRESHOLD = 3;

// Display palette. The primary feed is the "clear baseline" camera; the
// secondary is the foggy one. Colors flip between green/red based on the
// detector's verdict per tick.
const COLOR_OK = "#10b981";
const COLOR_FOG = "#dc2626";
const COLOR_SPIKE = "#eab308";
const COLOR_PRIMARY_LINE = "#0ea5e9";
const COLOR_SECONDARY_LINE = "#06b6d4";

interface CameraHealthPageProps {
  isActive: boolean;
}

interface FeedConfig {
  key: "primary" | "secondary";
  sourceId: string;
  cameraLabel: string;
  lineColor: string;
}

interface FeedState {
  fogged: boolean;
  regionCount: number;
  areaPct: number;
  consecutiveFoggedTicks: number;
  incidentsOpened: number;
  /** True once we've crossed INCIDENT_TICK_THRESHOLD for the current run. */
  incidentActive: boolean;
}

interface FeedSample {
  cameraLabel: string;
  fogged: boolean;
  regionCount: number;
  areaPct: number;
  incidentJustOpened: boolean;
}

interface PendingObservation {
  source_id: string;
  camera_label: string;
  fogged: boolean;
  region_count: number;
  area_pct: number;
}

interface ChartRow {
  ts: number;
  label: string;
  primary: number | null;
  secondary: number | null;
}

interface IncidentRow {
  id: number;
  ts: string;
  source_id: string;
  camera_label: string;
  region_count: number;
  area_pct: number;
}

const EMPTY_FEED_STATE: FeedState = {
  fogged: false,
  regionCount: 0,
  areaPct: 0,
  consecutiveFoggedTicks: 0,
  incidentsOpened: 0,
  incidentActive: false,
};

export function CameraHealthPage({ isActive }: CameraHealthPageProps) {
  const [primarySource, setPrimarySource] = useState("grocery-produce-aisle");
  const [secondarySource, setSecondarySource] = useState("grocery-produce-aisle-foggy-lens");
  const [primaryState, setPrimaryState] = useState<FeedState>(EMPTY_FEED_STATE);
  const [secondaryState, setSecondaryState] = useState<FeedState>(EMPTY_FEED_STATE);
  const [chartRows, setChartRows] = useState<ChartRow[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);

  // The fog_detector runs on any clip, but the demo is sharpest when paired
  // with the synthetic "foggy lens" clips against their clear baselines.
  // Surface those first in each picker.
  const candidates = useMemo(
    () => SAMPLE_VIDEOS.filter((s) => s.models.includes("fog_detector")),
    [],
  );

  const pendingRef = useRef<PendingObservation[]>([]);

  const updateFeedState = useCallback(
    (
      key: "primary" | "secondary",
      sample: FeedSample,
      sourceId: string,
    ) => {
      const setter = key === "primary" ? setPrimaryState : setSecondaryState;
      setter((prev) => {
        const nextConsec = sample.fogged ? prev.consecutiveFoggedTicks + 1 : 0;
        const crossed = nextConsec >= INCIDENT_TICK_THRESHOLD && !prev.incidentActive;
        return {
          fogged: sample.fogged,
          regionCount: sample.regionCount,
          areaPct: sample.areaPct,
          consecutiveFoggedTicks: nextConsec,
          incidentsOpened: prev.incidentsOpened + (crossed ? 1 : 0),
          incidentActive: nextConsec >= INCIDENT_TICK_THRESHOLD ? true : sample.fogged ? prev.incidentActive : false,
        };
      });

      pendingRef.current.push({
        source_id: sourceId,
        camera_label: sample.cameraLabel,
        fogged: sample.fogged,
        region_count: sample.regionCount,
        area_pct: sample.areaPct,
      });
    },
    [],
  );

  // Reset per-feed tally when the source changes - tracks from a clear clip
  // don't carry into the next clip.
  useEffect(() => {
    setPrimaryState(EMPTY_FEED_STATE);
  }, [primarySource]);
  useEffect(() => {
    setSecondaryState(EMPTY_FEED_STATE);
  }, [secondarySource]);

  // Batch-flush per-tick observations to Lakebase. Same retry-on-fail
  // pattern as guest_counts so a transient 5xx doesn't lose the events.
  useEffect(() => {
    if (!isActive) return;
    const flush = async () => {
      const batch = pendingRef.current.splice(0, pendingRef.current.length);
      if (batch.length === 0) return;
      try {
        const res = await fetch("/api/fog-observations", {
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

  const loadChart = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/fog-observations/recent?windowSec=${CHART_WINDOW_SEC}&bucketSec=${CHART_BUCKET_SEC}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as {
        rows: Array<{ source_id: string; bucket_ts: string; avg_area_pct: number }>;
      };
      const grouped = new Map<string, ChartRow>();
      for (const row of body.rows) {
        const ts = new Date(row.bucket_ts).getTime();
        const key = String(ts);
        const existing = grouped.get(key) ?? {
          ts,
          label: _formatBucketLabel(ts),
          primary: null,
          secondary: null,
        };
        if (row.source_id === primarySource) existing.primary = row.avg_area_pct;
        else if (row.source_id === secondarySource) existing.secondary = row.avg_area_pct;
        grouped.set(key, existing);
      }
      const sorted = Array.from(grouped.values()).sort((a, b) => a.ts - b.ts);
      setChartRows(sorted);
    } catch {
      // Chart is informational - the live feeds keep running on error.
    }
  }, [primarySource, secondarySource]);

  const loadIncidents = useCallback(async () => {
    try {
      const res = await fetch(`/api/fog-observations/incidents?limit=${INCIDENTS_LIMIT}`);
      if (!res.ok) return;
      const body = (await res.json()) as { rows: IncidentRow[] };
      setIncidents(body.rows);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void loadChart();
    const id = setInterval(() => void loadChart(), CHART_REFRESH_MS);
    return () => clearInterval(id);
  }, [isActive, loadChart]);

  useEffect(() => {
    if (!isActive) return;
    void loadIncidents();
    const id = setInterval(() => void loadIncidents(), INCIDENTS_REFRESH_MS);
    return () => clearInterval(id);
  }, [isActive, loadIncidents]);

  const camerasFoggedNow = (primaryState.fogged ? 1 : 0) + (secondaryState.fogged ? 1 : 0);
  const totalIncidents = primaryState.incidentsOpened + secondaryState.incidentsOpened;
  const primaryConfig: FeedConfig = useMemo(
    () => ({
      key: "primary",
      sourceId: primarySource,
      cameraLabel: getSampleVideo(primarySource)?.name ?? "Camera A",
      lineColor: COLOR_PRIMARY_LINE,
    }),
    [primarySource],
  );
  const secondaryConfig: FeedConfig = useMemo(
    () => ({
      key: "secondary",
      sourceId: secondarySource,
      cameraLabel: getSampleVideo(secondarySource)?.name ?? "Camera B",
      lineColor: COLOR_SECONDARY_LINE,
    }),
    [secondarySource],
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6 pb-4">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Cameras monitored</div>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-semibold tabular-nums text-slate-900">2</span>
              <span className="text-sm text-slate-500">streams running fog_detector</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 pb-4">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Cameras fogged now</div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-5xl font-semibold tabular-nums"
                style={{ color: camerasFoggedNow > 0 ? COLOR_FOG : COLOR_OK }}
              >
                {camerasFoggedNow}
              </span>
              <span className="text-sm text-slate-500">of 2 right now</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 pb-4">
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Cleaning tickets opened</div>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-semibold tabular-nums" style={{ color: COLOR_SECONDARY_LINE }}>
                {totalIncidents}
              </span>
              <span className="text-sm text-slate-500">since page load</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              One per sustained fog event (&ge; {INCIDENT_TICK_THRESHOLD} ticks).
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-tour="health-feeds">
        <FogFeed
          isActive={isActive}
          config={primaryConfig}
          candidates={candidates}
          state={primaryState}
          onSourceChange={setPrimarySource}
          onSample={(sample) => updateFeedState("primary", sample, primarySource)}
        />
        <FogFeed
          isActive={isActive}
          config={secondaryConfig}
          candidates={candidates}
          state={secondaryState}
          onSourceChange={setSecondarySource}
          onSample={(sample) => updateFeedState("secondary", sample, secondarySource)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Fog coverage over time</CardTitle>
            <CardDescription>
              Average % of frame flagged as fogged per camera, {CHART_BUCKET_SEC}s buckets,
              last {Math.round(CHART_WINDOW_SEC / 60)} min. Streamed from Lakebase Postgres.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {chartRows.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-slate-500">
                  Waiting for Lakebase to return buckets...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartRows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis
                      stroke="#94a3b8"
                      tick={{ fontSize: 10 }}
                      width={36}
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 12, padding: "4px 8px" }}
                      labelFormatter={(v) => `t=${v}`}
                      formatter={(value) => (typeof value === "number" ? `${value.toFixed(1)}%` : value)}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="primary"
                      name={primaryConfig.cameraLabel}
                      stroke={COLOR_PRIMARY_LINE}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="secondary"
                      name={secondaryConfig.cameraLabel}
                      stroke={COLOR_SECONDARY_LINE}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent fog events</CardTitle>
            <CardDescription>Latest fogged observations from Lakebase, refreshed every {Math.round(INCIDENTS_REFRESH_MS / 1000)}s.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {incidents.length === 0 ? (
                <div className="text-sm text-slate-500">No fog events recorded yet.</div>
              ) : (
                incidents.map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-3 px-3 py-2 rounded-md bg-slate-50">
                    <div className="flex items-start gap-2 min-w-0">
                      <CloudFog className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{r.camera_label}</div>
                        <div className="text-xs text-slate-500 tabular-nums">
                          {r.region_count} region{r.region_count === 1 ? "" : "s"}
                          {" - "}
                          {r.area_pct.toFixed(1)}% of frame
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums shrink-0 mt-0.5">
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

interface FogFeedProps {
  isActive: boolean;
  config: FeedConfig;
  candidates: typeof SAMPLE_VIDEOS;
  state: FeedState;
  onSourceChange: (id: string) => void;
  onSample: (sample: FeedSample) => void;
}

// Single CCTV feed running the fog_detector. The detector returns either:
//   - one full-frame `clear` detection (no fog)         -> verdict "Clear"
//   - one or more `fogged` bboxes per affected region   -> verdict "Fogged"
//
// We draw only fogged bboxes (semi-transparent red fill + outline + label).
// Drawing the "clear" full-frame bbox would just paint a giant rectangle
// over the feed and look broken.
function FogFeed({ isActive, config, candidates, state, onSourceChange, onSample }: FogFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inFlightRef = useRef(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sample = useMemo(() => getSampleVideo(config.sourceId), [config.sourceId]);

  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video || !sample) return;
    video.crossOrigin = "anonymous";
    video.loop = true;
    video.muted = true;
    video.src = sampleVideoUrl(sample);
    setStatus("Loading clip...");
    setErrorMessage(null);
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
      try {
        const result = await callDetector(frame.image, { model: "fog_detector" });
        const scaled = result.detections.map((d) => ({
          ...d,
          bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY),
        }));
        const fogged = scaled.filter((d) => d.label === "fogged");
        // Only the fogged bboxes get drawn. The detector emits a full-frame
        // `clear` bbox when no fog is found - that's a signal, not something
        // to render as a giant rectangle.
        setDetections(fogged);
        setErrorMessage(null);

        const frameW = video.videoWidth || 1;
        const frameH = video.videoHeight || 1;
        const frameArea = frameW * frameH;
        let foggedArea = 0;
        for (const d of fogged) {
          const [x1, y1, x2, y2] = d.bbox;
          foggedArea += Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        }
        const areaPct = frameArea > 0 ? Math.min(100, (foggedArea / frameArea) * 100) : 0;

        onSample({
          cameraLabel: config.cameraLabel,
          fogged: fogged.length > 0,
          regionCount: fogged.length,
          areaPct,
          incidentJustOpened: false,
        });

        setStatus(
          fogged.length > 0
            ? `${fogged.length} fogged region${fogged.length === 1 ? "" : "s"} - ${areaPct.toFixed(1)}% of frame`
            : "Lens clear",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setStatus("Detector unavailable");
      } finally {
        inFlightRef.current = false;
      }
    };
    const id = setInterval(tick, 1000 / FEED_FPS);
    return () => clearInterval(id);
  }, [isActive, config.sourceId, config.cameraLabel, onSample]);

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
    ctx.lineWidth = Math.max(3, Math.round(canvas.width / 300));
    const fontSize = Math.max(14, Math.round(canvas.width / 55));
    ctx.font = `${fontSize}px sans-serif`;
    for (const d of detections) {
      const [x1, y1, x2, y2] = d.bbox;
      const w = x2 - x1;
      const h = y2 - y1;
      // Semi-transparent fill draws the user's eye to the affected region
      // without fully obscuring the underlying CCTV.
      ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
      ctx.fillRect(x1, y1, w, h);
      ctx.strokeStyle = COLOR_FOG;
      ctx.strokeRect(x1, y1, w, h);
      const label = `FOGGED  ${(d.confidence * 100).toFixed(0)}%`;
      const padding = 6;
      const labelHeight = Math.max(20, Math.round(canvas.width / 45));
      const tw = ctx.measureText(label).width + padding * 2;
      ctx.fillStyle = COLOR_FOG;
      ctx.fillRect(x1, Math.max(0, y1 - labelHeight), tw, labelHeight);
      ctx.fillStyle = "white";
      ctx.fillText(label, x1 + padding, Math.max(labelHeight - padding, y1 - padding));
    }
  }, [detections, videoSize]);

  // Verdict drives the corner badge color: green when clear, yellow during a
  // brief spike (1-2 consecutive fogged ticks), red once a sustained fog
  // event has crossed INCIDENT_TICK_THRESHOLD.
  const verdict = state.fogged
    ? state.incidentActive
      ? { label: "FOGGED", color: COLOR_FOG }
      : { label: "FOG SPIKE", color: COLOR_SPIKE }
    : { label: "CLEAR", color: COLOR_OK };

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="space-y-1.5">
          <Label htmlFor={`source-${config.key}`}>{config.key === "primary" ? "Camera A" : "Camera B"}</Label>
          <Select value={config.sourceId} onValueChange={onSourceChange}>
            <SelectTrigger id={`source-${config.key}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Fog-detector clips</SelectLabel>
                {candidates.map((s) => (
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
          <Badge
            variant="outline"
            className="absolute top-2 left-2 gap-1.5 backdrop-blur bg-white/85"
            style={{ borderColor: verdict.color, color: verdict.color }}
          >
            {verdict.label === "CLEAR" ? <Eye className="w-3 h-3" /> : <CloudFog className="w-3 h-3" />}
            {verdict.label}
          </Badge>
          {state.fogged && (
            <Badge
              variant="outline"
              className="absolute top-2 right-2 gap-1.5 backdrop-blur bg-white/85 tabular-nums"
              style={{ borderColor: verdict.color, color: verdict.color }}
            >
              {state.regionCount} region{state.regionCount === 1 ? "" : "s"}
              {" - "}
              {state.areaPct.toFixed(0)}%
            </Badge>
          )}
        </div>
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          {status === "Loading clip..." ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {status || "Initializing..."}
        </div>
        {errorMessage && (
          <div className="text-xs text-red-600 break-words">{errorMessage}</div>
        )}
        <div className="grid grid-cols-3 gap-3 text-xs text-slate-600 pt-1">
          <div>
            <div className="text-slate-400 uppercase tracking-wider">Incidents</div>
            <div className="text-lg font-semibold tabular-nums" style={{ color: COLOR_FOG }}>
              {state.incidentsOpened}
            </div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wider">Run length</div>
            <div className="text-lg font-semibold tabular-nums">
              {state.consecutiveFoggedTicks}
            </div>
          </div>
          <div>
            <div className="text-slate-400 uppercase tracking-wider">Area now</div>
            <div className="text-lg font-semibold tabular-nums">
              {state.areaPct.toFixed(0)}%
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function _formatBucketLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function _formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}
