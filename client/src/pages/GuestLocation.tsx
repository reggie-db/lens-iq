import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider,
} from "@databricks/appkit-ui/react";
import {
  CartesianGrid, ComposedChart, Legend, Line, ReferenceLine,
  ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from "recharts";
import {
  Circle, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  AlertTriangle, Car, Loader2, Pause, Play, RotateCcw, ShieldCheck, Smartphone,
} from "lucide-react";
import { captureVideoFrameForDetection, scaleDetectionBbox } from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { getSampleVideo } from "../lib/samples";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { useSampleVideoStream } from "../lib/useSampleVideoStream";
import {
  computeEconomics, EVENT_COLORS, formatWait, offsetToLatLng, pointOnRoute, rankMenu,
  SCENARIOS, SESSION_EVENTS, SESSION_ROUTE, SESSION_SECONDS, SITE_CENTER,
  type Daypart, type DemandInputs, type SessionEvent, type VehicleClass, type Weather,
} from "../lib/guest-location";
import { useTheme } from "../lib/theme";

// Guest Location page.
//
// Demonstrates the pairing the whole concept rests on: the app supplies
// identity and preferences, the cameras supply an anonymous position. Nothing
// here identifies a customer from video - no faces, no plates, no persistent
// vehicle fingerprint.
//
// One signal on this page is real. The lane camera runs YOLO on the
// `drive-thru-lane` clip, which frames the ordering lanes and nothing else, so
// the vehicle count in frame IS the live queue depth. Everything downstream
// (wait, balk, spend, menu ranking) is a deterministic model over that number
// plus the operator's controls, because a booth demo has no opted-in phones and
// no POS feed. Cards that render modelled numbers say so.
//
// The queue depth can also be driven by hand. A real lane sits at four or five
// cars, so a presenter who wants to show the balk cliff at fourteen can switch
// the source to Manual instead of waiting for a queue that never comes.

const FEED_FPS = 1;
const TICK_INTERVAL_MS = Math.round(1000 / FEED_FPS);

const LANE_CAMERA_SAMPLE = "drive-thru-lane";

// Rolling window for the live queue depth. YOLO occasionally drops the vehicle
// furthest back in the lane; averaging three ticks keeps the headline number
// from flickering while the bbox overlay still shows the latest frame.
const SMOOTH_WINDOW = 3;

// Confidence floor for the lane camera. Vehicles at the back of a night-time
// lane are small and dim, so this sits below the app-wide 0.35 default to keep
// the far end of the queue counted.
const LANE_CONF = 0.25;

const VEHICLE_LABELS = new Set(["car", "truck", "bus", "motorcycle"]);

// Bright cyan reads well on video and on the chart, but no single cyan clears
// 4.5:1 against both a white and a near-black card, so accent *text* uses a
// per-theme Tailwind pair instead of an inline hex.
const COLOR_VEHICLE = "#0ea5e9";
const ACCENT_TEXT = "text-sky-700 dark:text-sky-300";
const COLOR_SPEND = "#a855f7";
const COLOR_BALK = "#ef4444";

/** Queue depths the spend / balk curve is plotted across. */
const CURVE_MAX_DEPTH = 18;

// Basemaps for the session map. Both render OpenStreetMap data; the dark
// variant is CARTO's styling of the same, because standard OSM raster tiles
// are light-only and glare against the dark theme.
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILES = {
  light: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM_ATTRIBUTION,
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
  },
} as const;

const DAYPARTS: Daypart[] = ["breakfast", "lunch", "dinner", "late"];
const VEHICLE_CLASSES: VehicleClass[] = ["motorcycle", "car", "large"];
const WEATHERS: Weather[] = ["hot", "mild", "cold"];

interface GuestLocationPageProps {
  isActive: boolean;
}

export function GuestLocationPage({ isActive }: GuestLocationPageProps) {
  // Live queue depth measured by the lane camera, and the operator's override.
  const [cameraDepth, setCameraDepth] = useState(0);
  const [queueSource, setQueueSource] = useState<"camera" | "manual">("camera");
  const [manualDepth, setManualDepth] = useState(8);

  // Modelled context the app side would already know.
  const [daypart, setDaypart] = useState<Daypart>("lunch");
  const [partySize, setPartySize] = useState(2);
  const [vehicleClass, setVehicleClass] = useState<VehicleClass>("car");
  const [weather, setWeather] = useState<Weather>("hot");
  const [staffedLanes, setStaffedLanes] = useState(1);
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);

  const queueDepth = queueSource === "camera" ? cameraDepth : manualDepth;

  const inputs: DemandInputs = useMemo(
    () => ({ queueDepth, daypart, partySize, vehicleClass, weather, staffedLanes }),
    [queueDepth, daypart, partySize, vehicleClass, weather, staffedLanes],
  );

  const economics = useMemo(() => computeEconomics(inputs), [inputs]);
  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0],
    [scenarioId],
  );
  const menu = useMemo(
    () => rankMenu(inputs, scenario, economics.waitSeconds),
    [inputs, scenario, economics.waitSeconds],
  );

  return (
    <div className="space-y-6 pb-12">
      <PrivacyHeader />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <LaneCamera
          isActive={isActive}
          onDepthChange={setCameraDepth}
          queueSource={queueSource}
          onQueueSourceChange={setQueueSource}
          manualDepth={manualDepth}
          onManualDepthChange={setManualDepth}
          liveDepth={cameraDepth}
        />
        <SessionMap />
      </div>

      <QueuePanel
        inputs={inputs}
        economics={economics}
        queueSource={queueSource}
        staffedLanes={staffedLanes}
        onStaffedLanesChange={setStaffedLanes}
      />

      <MenuPanel
        scenario={scenario}
        onScenarioChange={setScenarioId}
        menu={menu}
        inputs={inputs}
        waitSeconds={economics.waitSeconds}
        daypart={daypart}
        onDaypartChange={setDaypart}
        partySize={partySize}
        onPartySizeChange={setPartySize}
        vehicleClass={vehicleClass}
        onVehicleClassChange={setVehicleClass}
        weather={weather}
        onWeatherChange={setWeather}
      />
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────

function PrivacyHeader() {
  return (
    <Card className="bg-muted/40 border-border">
      <CardContent className="py-5 space-y-3">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Guest location
        </div>
        <div className="text-lg font-medium text-foreground">
          The app knows who you are. The camera only knows something arrived.
        </div>
        <p className="text-sm text-muted-foreground max-w-4xl">
          The camera never identifies the customer. It observes an anonymous
          arrival at approximately the same time as a consented app session,
          tracks that temporary session through store zones, and deletes the
          association after the visit. Because the menu is a suggestion rather
          than a claim about identity, being wrong costs a shrug instead of a
          bad experience.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge variant="outline" className="gap-1.5">
            <Car className="w-3 h-3" />
            <span>Live: queue depth from YOLO</span>
          </Badge>
          <Badge variant="outline" className="gap-1.5">
            <Smartphone className="w-3 h-3" />
            <span>Modelled: phone pings, POS, spend</span>
          </Badge>
          <Badge variant="outline" className="gap-1.5">
            <ShieldCheck className="w-3 h-3" />
            <span>No faces, plates, or vehicle fingerprints</span>
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Lane camera (the one real signal) ────────────────────────────────

interface LaneCameraProps {
  isActive: boolean;
  onDepthChange: (depth: number) => void;
  queueSource: "camera" | "manual";
  onQueueSourceChange: (source: "camera" | "manual") => void;
  manualDepth: number;
  onManualDepthChange: (depth: number) => void;
  liveDepth: number;
}

function LaneCamera({
  isActive, onDepthChange, queueSource, onQueueSourceChange,
  manualDepth, onManualDepthChange, liveDepth,
}: LaneCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Rolling raw counts feeding the smoothed headline number.
  const windowRef = useRef<number[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [rawCount, setRawCount] = useState(0);
  const [error, setError] = useState("");

  const sample = useMemo(() => getSampleVideo(LANE_CAMERA_SAMPLE) ?? null, []);
  const { videoSize, status: videoStatus } = useSampleVideoStream(videoRef, {
    isActive,
    sample,
  });

  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const frame = await captureVideoFrameForDetection(video);
    if (!frame) return;
    try {
      const result = await callDetector(frame.image, {
        model: "yolo",
        conf: LANE_CONF,
        fingerprint: frame.fingerprint,
      });
      const vehicles = result.detections
        .filter((d) => VEHICLE_LABELS.has(d.label))
        .map((d) => ({ ...d, bbox: scaleDetectionBbox(d.bbox, frame.scaleX, frame.scaleY) }));
      setDetections(vehicles);
      setRawCount(vehicles.length);
      setError("");

      const win = windowRef.current;
      win.push(vehicles.length);
      if (win.length > SMOOTH_WINDOW) win.shift();
      const mean = win.reduce((a, b) => a + b, 0) / win.length;
      onDepthChange(Math.round(mean));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onDepthChange]);

  useDetectionLoop({ isActive, intervalMs: TICK_INTERVAL_MS, tick });

  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => ({
        bbox: d.bbox,
        color: COLOR_VEHICLE,
        label: `${d.label} ${(d.confidence * 100).toFixed(0)}%`,
        fillAlpha: 0.14,
        labelAlpha: 0.95,
      })),
    [detections],
  );

  useEffect(() => {
    drawBboxOverlay(canvasRef.current, videoRef.current, videoSize, overlayBoxes);
  }, [overlayBoxes, videoSize]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Car className="w-5 h-5 text-muted-foreground" />
          Drive-through lane camera
        </CardTitle>
        <CardDescription>
          A fixed forecourt camera on the drive-through order point. YOLO counts
          the vehicles on camera once per second and the queue builds as the
          clip runs. This count is the only measured number on the page, and it
          drives all the rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
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
          {/* Anchored right so the clip's burnt-in "CAM 07" label stays legible. */}
          <div className="absolute top-2 right-2">
            <Badge
              variant="outline"
              className={`gap-1.5 backdrop-blur bg-background/85 ${ACCENT_TEXT}`}
              style={{ borderColor: COLOR_VEHICLE }}
            >
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: COLOR_VEHICLE }} />
              {rawCount} on camera
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <div className="space-y-1.5">
            <Label htmlFor="queue-source">Queue depth source</Label>
            <Select value={queueSource} onValueChange={(v) => onQueueSourceChange(v as "camera" | "manual")}>
              <SelectTrigger id="queue-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="camera">Camera (live YOLO count)</SelectItem>
                <SelectItem value="manual">Manual (walk the curve)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {queueSource === "manual" ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="manual-depth" className="text-xs text-muted-foreground">
                  Cars in lane
                </Label>
                <span className={`text-xs font-mono tabular-nums ${ACCENT_TEXT}`}>
                  {manualDepth}
                </span>
              </div>
              <Slider
                id="manual-depth"
                min={1}
                max={CURVE_MAX_DEPTH}
                step={1}
                value={[manualDepth]}
                onValueChange={(v) => onManualDepthChange(v[0] ?? manualDepth)}
              />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Smoothed over {SMOOTH_WINDOW} ticks:{" "}
              <span className={`font-mono tabular-nums ${ACCENT_TEXT}`}>{liveDepth}</span>{" "}
              vehicle{liveDepth === 1 ? "" : "s"} on camera
            </div>
          )}
        </div>

        <div className="text-xs text-muted-foreground break-words">
          {videoStatus.kind === "loading" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              {videoStatus.message}
            </span>
          ) : videoStatus.kind === "error" ? (
            videoStatus.message
          ) : null}
        </div>
        {error && videoStatus.kind !== "error" && (
          <div className="text-xs text-red-600 break-words flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Consented-session map ────────────────────────────────────────────

const LEGEND: Array<{ kind: keyof typeof EVENT_COLORS; label: string }> = [
  { kind: "phone", label: "Phone-location detection" },
  { kind: "gap", label: "GPS uncertainty / coverage gap" },
  { kind: "camera", label: "Anonymous camera event" },
  { kind: "menu", label: "Personalized menu delivered" },
];

function SessionMap() {
  const [elapsed, setElapsed] = useState(SESSION_SECONDS);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { resolved: theme } = useTheme();

  // Drive the scrubber from a single interval. Playback restarts from zero
  // when the operator hits play at the end of the run.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setElapsed((prev) => {
        if (prev >= SESSION_SECONDS) {
          setPlaying(false);
          return SESSION_SECONDS;
        }
        return prev + 1;
      });
    }, 420);
    return () => clearInterval(id);
  }, [playing]);

  const visible = useMemo(
    () => SESSION_EVENTS.filter((e) => e.at <= elapsed),
    [elapsed],
  );
  const latest = visible[visible.length - 1];
  const selected = useMemo(
    () => SESSION_EVENTS.find((e) => e.id === selectedId) ?? latest,
    [selectedId, latest],
  );

  const marker = pointOnRoute(elapsed / SESSION_SECONDS);

  const play = () => {
    if (elapsed >= SESSION_SECONDS) setElapsed(0);
    setPlaying(true);
  };

  const tiles = theme === "dark" ? TILES.dark : TILES.light;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-muted-foreground" />
          Consented session, entrance to window
        </CardTitle>
        <CardDescription>
          Phone location gets the customer to the property. Cameras carry an
          anonymous session through the gap where GPS stops working. Scrub the
          timeline or click any event.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg border border-border overflow-hidden h-[380px]">
          <MapContainer
            center={[SITE_CENTER[0], SITE_CENTER[1]]}
            zoom={18}
            scrollWheelZoom={false}
            className="h-full w-full"
            style={{ background: "var(--muted)" }}
          >
            {/* Keyed on the theme so switching appearance swaps the basemap
                instead of leaving light tiles under a dark UI. */}
            <TileLayer key={theme} url={tiles.url} attribution={tiles.attribution} maxZoom={19} />

            {/* The route the vehicle takes across the site. */}
            <Polyline
              positions={SESSION_ROUTE as [number, number][]}
              pathOptions={{ color: EVENT_COLORS.camera, weight: 5, opacity: 0.35 }}
            />

            {/* Events revealed so far, oldest first so later markers sit on top. */}
            {visible.map((event) => (
              <MapEvent
                key={event.id}
                event={event}
                active={selected?.id === event.id}
                onSelect={() => setSelectedId(event.id)}
              />
            ))}

            {/* The anonymous session itself. */}
            <CircleMarker
              center={marker}
              radius={7}
              pathOptions={{
                color: "#ffffff",
                weight: 2,
                fillColor: "#111827",
                fillOpacity: 1,
              }}
            />
          </MapContainer>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={playing ? () => setPlaying(false) : play}>
            {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {playing ? "Pause" : "Play session"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() => {
              setPlaying(false);
              setElapsed(0);
              setSelectedId(null);
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </Button>
          <Slider
            min={0}
            max={SESSION_SECONDS}
            step={1}
            value={[elapsed]}
            onValueChange={(v) => {
              setPlaying(false);
              setElapsed(v[0] ?? elapsed);
              setSelectedId(null);
            }}
            className="flex-1"
            aria-label="Session timeline"
          />
          <span className="text-xs font-mono tabular-nums text-muted-foreground w-10 text-right">
            {elapsed}s
          </span>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {LEGEND.map(({ kind, label }) => (
            <span key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{
                  backgroundColor: kind === "gap" ? "transparent" : EVENT_COLORS[kind],
                  border: kind === "gap" ? `1px dashed ${EVENT_COLORS.gap}` : undefined,
                }}
              />
              {label}
            </span>
          ))}
        </div>

        {selected && (
          <div className="rounded-lg border border-border bg-background p-3 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: EVENT_COLORS[selected.kind] }}
              />
              <span className="text-sm font-medium text-foreground">{selected.title}</span>
              <span className="text-xs font-mono text-muted-foreground ml-auto">t+{selected.at}s</span>
            </div>
            <p className="text-xs text-muted-foreground">{selected.detail}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface MapEventProps {
  event: SessionEvent;
  active: boolean;
  onSelect: () => void;
}

function MapEvent({ event, active, onSelect }: MapEventProps) {
  const color = EVENT_COLORS[event.kind];
  const center = offsetToLatLng(event.east, event.north);
  return (
    <>
      {/* Accuracy is drawn as a Leaflet Circle, whose radius is in real
          metres, so the halo grows and shrinks against the actual map scale.
          That is the point of the story: reported accuracy is wider than the
          zones the app is trying to tell apart. */}
      {event.accuracyM != null && (
        <Circle
          center={center}
          radius={event.accuracyM}
          pathOptions={{
            color,
            weight: 1.5,
            opacity: 0.8,
            fillColor: color,
            fillOpacity: event.kind === "gap" ? 0.1 : 0.15,
            dashArray: event.kind === "gap" ? "6 5" : undefined,
          }}
        />
      )}
      <CircleMarker
        center={center}
        radius={active ? 9 : 6}
        pathOptions={{ color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1 }}
        eventHandlers={{ click: onSelect }}
      >
        <Tooltip direction="top" offset={[0, -6]}>
          <span className="text-xs">
            t+{event.at}s {event.title}
          </span>
        </Tooltip>
      </CircleMarker>
    </>
  );
}

// ─── Queue economics ──────────────────────────────────────────────────

interface QueuePanelProps {
  inputs: DemandInputs;
  economics: ReturnType<typeof computeEconomics>;
  queueSource: "camera" | "manual";
  staffedLanes: number;
  onStaffedLanesChange: (lanes: number) => void;
}

function QueuePanel({
  inputs, economics, queueSource, staffedLanes, onStaffedLanesChange,
}: QueuePanelProps) {
  // Sweep the same model across every queue depth so the operator can see
  // where the spend and balk curves cross, not just today's point on them.
  const curve = useMemo(() => {
    const rows: Array<{ depth: number; spend: number; balk: number }> = [];
    for (let depth = 1; depth <= CURVE_MAX_DEPTH; depth += 1) {
      const point = computeEconomics({ ...inputs, queueDepth: depth });
      rows.push({
        depth,
        spend: Number(point.avgSpend.toFixed(2)),
        balk: Number((point.balkRate * 100).toFixed(1)),
      });
    }
    return rows;
  }, [inputs]);

  const spendGap = economics.uncongestedSpend - economics.avgSpend;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Balk detection: cars counted versus tickets rung</CardTitle>
        <CardDescription>
          The cameras see every vehicle that joins the line. The POS only sees
          the ones that stay. The gap between those two numbers is demand you
          already paid to attract and then lost to the wait.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <MetricCard
            label="Vehicles detected"
            value={String(economics.carsDetected)}
            caption={queueSource === "camera" ? "live from the lane camera" : "manual queue depth"}
            valueClassName={ACCENT_TEXT}
          />
          <MetricCard
            label="POS tickets"
            value={String(economics.posOrders)}
            caption="modelled from wait time"
          />
          <MetricCard
            label="Balked"
            value={String(economics.balkedCars)}
            caption={`${(economics.balkRate * 100).toFixed(0)}% of arrivals`}
            color={COLOR_BALK}
          />
          <MetricCard
            label="Avg spend"
            value={`$${economics.avgSpend.toFixed(2)}`}
            caption={`$${spendGap.toFixed(2)} below a clear lane`}
            color={COLOR_SPEND}
          />
          <MetricCard
            label="Lost revenue"
            value={`$${economics.lostRevenue.toFixed(0)}`}
            caption={`at a ${formatWait(economics.waitSeconds)} wait`}
            color={COLOR_BALK}
          />
        </div>

        <div className="space-y-1.5 max-w-sm">
          <div className="flex items-center justify-between">
            <Label htmlFor="staffed-lanes" className="text-xs text-muted-foreground">
              Staffed order points
            </Label>
            <span className="text-xs font-mono tabular-nums text-foreground">{staffedLanes}</span>
          </div>
          <Slider
            id="staffed-lanes"
            min={1}
            max={3}
            step={1}
            value={[staffedLanes]}
            onValueChange={(v) => onStaffedLanesChange(v[0] ?? staffedLanes)}
          />
          <p className="text-xs text-muted-foreground">
            Adding a second order point splits the same queue and moves the
            whole curve. That is the operational lever the camera count
            justifies.
          </p>
        </div>

        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={curve} margin={{ top: 20, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis
                dataKey="depth"
                stroke="var(--chart-axis-label)"
                fontSize={11}
                label={{
                  value: "Cars detected in lane",
                  position: "insideBottom",
                  offset: -2,
                  fill: "var(--chart-axis-label)",
                  fontSize: 11,
                }}
              />
              <YAxis
                yAxisId="spend"
                stroke="var(--chart-axis-label)"
                fontSize={11}
                tickFormatter={(v) => `$${v}`}
              />
              <YAxis
                yAxisId="balk"
                orientation="right"
                stroke="var(--chart-axis-label)"
                fontSize={11}
                tickFormatter={(v) => `${v}%`}
              />
              <ChartTooltip
                contentStyle={{
                  background: "var(--chart-tooltip-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "var(--foreground)",
                }}
                formatter={(value, name) =>
                  name === "Avg spend" ? [`$${value}`, name] : [`${value}%`, name]
                }
                labelFormatter={(v) => `${v} cars in lane`}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine
                yAxisId="spend"
                x={Math.min(CURVE_MAX_DEPTH, Math.max(1, economics.carsDetected))}
                stroke="var(--foreground)"
                strokeDasharray="4 3"
                label={{ value: "now", position: "top", fill: "var(--foreground)", fontSize: 10 }}
              />
              <Line
                yAxisId="spend"
                type="monotone"
                dataKey="spend"
                name="Avg spend"
                stroke={COLOR_SPEND}
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="balk"
                type="monotone"
                dataKey="balk"
                name="Balk rate"
                stroke={COLOR_BALK}
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  caption: string;
  /** Inline color for values whose hue clears contrast in both themes. */
  color?: string;
  /** Per-theme class pair, for values that need one. Wins over `color`. */
  valueClassName?: string;
}

function MetricCard({ label, value, caption, color, valueClassName }: MetricCardProps) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-0.5">{label}</div>
      <div
        className={`text-2xl font-semibold tabular-nums ${valueClassName ?? ""}`}
        style={!valueClassName && color ? { color } : undefined}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{caption}</div>
    </div>
  );
}

// ─── Personalized menu ────────────────────────────────────────────────

interface MenuPanelProps {
  scenario: (typeof SCENARIOS)[number];
  onScenarioChange: (id: string) => void;
  menu: ReturnType<typeof rankMenu>;
  inputs: DemandInputs;
  waitSeconds: number;
  daypart: Daypart;
  onDaypartChange: (d: Daypart) => void;
  partySize: number;
  onPartySizeChange: (n: number) => void;
  vehicleClass: VehicleClass;
  onVehicleClassChange: (v: VehicleClass) => void;
  weather: Weather;
  onWeatherChange: (w: Weather) => void;
}

function MenuPanel({
  scenario, onScenarioChange, menu, inputs, waitSeconds,
  daypart, onDaypartChange, partySize, onPartySizeChange,
  vehicleClass, onVehicleClassChange, weather, onWeatherChange,
}: MenuPanelProps) {
  const longWait = waitSeconds > 210;

  return (
    <Card>
      <CardHeader>
        <CardTitle>What the customer sees at the board</CardTitle>
        <CardDescription>
          Pick a play, then move the context. The ranking is a suggestion built
          from app history plus live lane conditions, so it reorders as the
          queue and the situation change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="scenario">Play</Label>
              <Select value={scenario.id} onValueChange={onScenarioChange}>
                <SelectTrigger id="scenario"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCENARIOS.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-lg border border-border bg-background p-3 space-y-2 text-xs">
              <SignalRow color={EVENT_COLORS.phone} label="App supplies" value={scenario.appSignal} />
              <SignalRow color={EVENT_COLORS.camera} label="Camera supplies" value={scenario.cameraSignal} />
              <SignalRow color={EVENT_COLORS.menu} label="Why it pays" value={scenario.value} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="daypart" className="text-xs text-muted-foreground">Daypart</Label>
                <Select value={daypart} onValueChange={(v) => onDaypartChange(v as Daypart)}>
                  <SelectTrigger id="daypart"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAYPARTS.map((d) => (
                      <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="weather" className="text-xs text-muted-foreground">Weather</Label>
                <Select value={weather} onValueChange={(v) => onWeatherChange(v as Weather)}>
                  <SelectTrigger id="weather"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WEATHERS.map((w) => (
                      <SelectItem key={w} value={w} className="capitalize">{w}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vehicle-class" className="text-xs text-muted-foreground">
                  Vehicle class (camera)
                </Label>
                <Select value={vehicleClass} onValueChange={(v) => onVehicleClassChange(v as VehicleClass)}>
                  <SelectTrigger id="vehicle-class"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VEHICLE_CLASSES.map((v) => (
                      <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="party-size" className="text-xs text-muted-foreground">
                    Occupants seen
                  </Label>
                  <span className="text-xs font-mono tabular-nums text-foreground">{partySize}</span>
                </div>
                <Slider
                  id="party-size"
                  min={1}
                  max={5}
                  step={1}
                  value={[partySize]}
                  onValueChange={(v) => onPartySizeChange(v[0] ?? partySize)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Menu board
              </span>
              <Badge variant="outline" className="gap-1.5 text-xs">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: longWait ? COLOR_BALK : EVENT_COLORS.camera }}
                />
                {inputs.queueDepth} car{inputs.queueDepth === 1 ? "" : "s"} ahead,{" "}
                {formatWait(waitSeconds)} wait
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {longWait
                ? "Long line: the board leads with items the kitchen can turn over fast, to protect throughput."
                : "Short line: there is room to build, so premium and customizable items move up."}
            </p>
            <div className="space-y-2">
              {menu.map((item, idx) => (
                <div
                  key={item.name}
                  className="flex items-start gap-3 rounded-lg border border-border bg-background p-3"
                  style={idx === 0 ? { borderColor: EVENT_COLORS.menu } : undefined}
                >
                  <span
                    className="text-xs font-mono tabular-nums mt-0.5 shrink-0"
                    style={{ color: idx === 0 ? EVENT_COLORS.menu : undefined }}
                  >
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{item.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.reason} · {Math.round(item.prepSeconds)}s prep
                    </div>
                  </div>
                  <span className="text-sm font-mono tabular-nums text-foreground shrink-0">
                    ${item.price.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SignalRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="inline-block w-2 h-2 rounded-full mt-1 shrink-0" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground shrink-0 w-28">{label}</span>
      <span className="text-foreground min-w-0">{value}</span>
    </div>
  );
}
