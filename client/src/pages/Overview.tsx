import { useNavigate } from "react-router-dom";
import {
  Badge, Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@databricks/appkit-ui/react";
import {
  AlertTriangle, Camera, Car, CheckCircle2, CloudFog, Cone, DollarSign,
  HardHat, MapPin, PiggyBank, ScanFace, ShieldAlert, Sparkles, TrendingDown,
  TrendingUp, Users,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// Fleet Operations Dashboard.
//
// Booth landing page. Tells the company-wide value story across all the CV
// use cases the model demos drill into. Every number on this page is
// HARD-CODED DEMO DATA - this is the "boardroom view" we lead with at the
// booth, and the model-demo pages (/spills, /plates, /guests, /clarity,
// /faces) are what we click into when the customer wants to see the
// underlying tech.
//
// When this gets wired to live aggregates, swap the constants for
// `useAnalyticsQuery` hits against `app_data.*` and the layout is unchanged.

const CHART_TOOLTIP_STYLE = {
  backgroundColor: "white",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  fontSize: "12px",
  color: "#0f172a",
} as const;

const COLOR = {
  spill: "#eab308",
  plate: "#0ea5e9",
  guests: "#10b981",
  fog: "#06b6d4",
  faces: "#a855f7",
  ppe: "#f97316",
  slate: "#64748b",
  ok: "#16a34a",
  warn: "#f59e0b",
  bad: "#dc2626",
} as const;

// ─── Fleet KPI hero ───────────────────────────────────────────────────

interface HeadlineKpi {
  label: string;
  value: string;
  caption: string;
  trend: { dir: "up" | "down"; value: string; tone: "good" | "bad" | "neutral" };
  icon: typeof DollarSign;
  color: string;
}

const HEADLINE_KPIS: HeadlineKpi[] = [
  {
    label: "Avoided slip claims YTD",
    value: "$312K",
    caption: "12 contested claims with timestamped video evidence",
    trend: { dir: "up", value: "+$58K vs Q3", tone: "good" },
    icon: PiggyBank,
    color: COLOR.spill,
  },
  {
    label: "Drive-off losses recovered",
    value: "$184K",
    caption: "Plate-to-POS join, 89 unmatched fills resolved",
    trend: { dir: "up", value: "+22% QoQ", tone: "good" },
    icon: DollarSign,
    color: COLOR.plate,
  },
  {
    label: "Pump → store conversion",
    value: "38.4%",
    caption: "Fleet average, 12-week rolling",
    trend: { dir: "up", value: "+6.2 pp YoY", tone: "good" },
    icon: TrendingUp,
    color: COLOR.guests,
  },
  {
    label: "Banned-shopper interventions",
    value: "47",
    caption: "5 confirmed prevented incidents this quarter",
    trend: { dir: "up", value: "+11 vs Q3", tone: "neutral" },
    icon: ShieldAlert,
    color: COLOR.faces,
  },
];

// ─── Multi-store snapshot ─────────────────────────────────────────────

type StoreHealth = "healthy" | "watch" | "intervene";

interface StoreSnapshot {
  id: string;
  city: string;
  format: string;
  health: StoreHealth;
  timeToCone: number;
  conversion: number;
  cameraHealth: number;
  weeklyIncidents: number;
  headline: string;
}

const STORES: StoreSnapshot[] = [
  { id: "S-ATL-001", city: "Atlanta, GA",  format: "Flagship",   health: "healthy",   timeToCone: 62,  conversion: 51, cameraHealth: 100, weeklyIncidents: 1, headline: "Best conversion in fleet" },
  { id: "S-ATL-002", city: "Atlanta, GA",  format: "Standard",   health: "healthy",   timeToCone: 71,  conversion: 44, cameraHealth: 100, weeklyIncidents: 0, headline: "Clean week" },
  { id: "S-DAL-001", city: "Dallas, TX",   format: "Travel hub", health: "watch",     timeToCone: 88,  conversion: 41, cameraHealth: 96,  weeklyIncidents: 2, headline: "1 camera fogged on canopy" },
  { id: "S-HOU-001", city: "Houston, TX",  format: "Standard",   health: "intervene", timeToCone: 142, conversion: 24, cameraHealth: 92,  weeklyIncidents: 5, headline: "Slow spill response Tue closing" },
  { id: "S-TAM-001", city: "Tampa, FL",    format: "Coastal",    health: "watch",     timeToCone: 94,  conversion: 33, cameraHealth: 98,  weeklyIncidents: 3, headline: "2 drive-off candidates flagged" },
  { id: "S-TAM-002", city: "Tampa, FL",    format: "Standard",   health: "healthy",   timeToCone: 68,  conversion: 39, cameraHealth: 100, weeklyIncidents: 1, headline: "VIP recognition: 4 hits" },
  { id: "S-NAS-001", city: "Nashville, TN", format: "Flagship",  health: "healthy",   timeToCone: 75,  conversion: 47, cameraHealth: 100, weeklyIncidents: 0, headline: "Top PPE compliance" },
  { id: "S-CHA-001", city: "Charlotte, NC", format: "Standard",  health: "watch",     timeToCone: 99,  conversion: 36, cameraHealth: 95,  weeklyIncidents: 2, headline: "Freezer dome cam needs wipe" },
];

const HEALTH_BADGE: Record<StoreHealth, { label: string; tone: string }> = {
  healthy:   { label: "On target",   tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  watch:     { label: "Watch",       tone: "bg-amber-50 text-amber-700 border-amber-200" },
  intervene: { label: "Intervene",   tone: "bg-red-50 text-red-700 border-red-200" },
};

// ─── Per-use-case data ────────────────────────────────────────────────

// Spill response: per-store time-to-cone, fleet target 90s.
const SPILL_RESPONSE = STORES.map((s) => ({
  store: s.id.replace("S-", ""),
  seconds: s.timeToCone,
}));

// Plates: daily captures + drive-off flags over 14 days.
const PLATE_TIMESERIES = [
  { day: "Mon",  captures: 2160, flagged: 4 },
  { day: "Tue",  captures: 2278, flagged: 6 },
  { day: "Wed",  captures: 2412, flagged: 5 },
  { day: "Thu",  captures: 2589, flagged: 7 },
  { day: "Fri",  captures: 3122, flagged: 9 },
  { day: "Sat",  captures: 3478, flagged: 11 },
  { day: "Sun",  captures: 2914, flagged: 8 },
  { day: "Mon ", captures: 2244, flagged: 3 },
  { day: "Tue ", captures: 2320, flagged: 4 },
  { day: "Wed ", captures: 2401, flagged: 5 },
  { day: "Thu ", captures: 2515, flagged: 6 },
  { day: "Fri ", captures: 3208, flagged: 8 },
  { day: "Sat ", captures: 3562, flagged: 10 },
  { day: "Sun ", captures: 2987, flagged: 6 },
];

// Guests: pump-to-store conversion per store.
const CONVERSION_BY_STORE = STORES.map((s) => ({
  store: s.id.replace("S-", ""),
  conversion: s.conversion,
}));

// Camera health: fogged % by camera position type (canopy / aisle / drive-thru / back-of-house).
const CAMERA_HEALTH = [
  { position: "Canopy",     fleetCount: 38, fogged: 1.4, threshold: 5 },
  { position: "Aisle dome", fleetCount: 56, fogged: 0.6, threshold: 5 },
  { position: "Drive-thru", fleetCount: 24, fogged: 0.9, threshold: 5 },
  { position: "Back-house", fleetCount: 24, fogged: 0.2, threshold: 5 },
];

// Facial recognition: weekly matches by role.
const FACE_MATCH_WEEKLY = [
  { week: "W-13", banned: 4,  vip: 12, staff: 422 },
  { week: "W-12", banned: 6,  vip: 9,  staff: 438 },
  { week: "W-11", banned: 3,  vip: 14, staff: 451 },
  { week: "W-10", banned: 8,  vip: 18, staff: 462 },
  { week: "W-9",  banned: 5,  vip: 11, staff: 449 },
  { week: "W-8",  banned: 7,  vip: 16, staff: 471 },
  { week: "W-7",  banned: 11, vip: 22, staff: 488 },
];

// ─── Page ─────────────────────────────────────────────────────────────

export function OverviewPage() {
  return (
    <div className="space-y-6 pb-12">
      <DemoHeader />

      <HeadlineRow />

      <FleetMap />

      <SpillResponseSection />

      <PlatesSection />

      <ConversionSection />

      <CameraHealthSection />

      <FacialRecognitionSection />

      <SpecialtyModelsSection />

      <SeeItLiveFooter />
    </div>
  );
}

// ─── Layout pieces ────────────────────────────────────────────────────

function DemoHeader() {
  return (
    <Card className="bg-gradient-to-r from-slate-50 to-white border-slate-200">
      <CardContent className="py-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">
            Fleet operations dashboard
          </div>
          <div className="text-lg font-medium text-slate-900">
            Eight stores. One lake. Every camera tied to a dollar line.
          </div>
          <div className="text-sm text-slate-600 mt-1">
            This is the boardroom view. Each section below clicks through to
            the live model demo behind that number.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 text-xs">
            <Sparkles className="w-3 h-3" />
            <span>Demo data</span>
          </Badge>
          <Badge variant="outline" className="gap-1 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>8 stores · 142 cameras</span>
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function HeadlineRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {HEADLINE_KPIS.map((kpi) => {
        const Icon = kpi.icon;
        const TrendIcon = kpi.trend.dir === "up" ? TrendingUp : TrendingDown;
        const trendTone =
          kpi.trend.tone === "good" ? "text-emerald-600"
            : kpi.trend.tone === "bad" ? "text-red-600"
              : "text-slate-600";
        return (
          <Card key={kpi.label} className="overflow-hidden">
            <CardContent className="pt-5 space-y-2">
              <div className="flex items-center justify-between">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${kpi.color}20` }}
                >
                  <Icon className="w-5 h-5" style={{ color: kpi.color }} />
                </div>
                <Badge variant="outline" className={`gap-1 ${trendTone}`}>
                  <TrendIcon className="w-3 h-3" />
                  <span className="text-xs">{kpi.trend.value}</span>
                </Badge>
              </div>
              <div className="text-3xl font-semibold tracking-tight text-slate-900">
                {kpi.value}
              </div>
              <div className="text-sm text-slate-700">{kpi.label}</div>
              <div className="text-xs text-slate-500">{kpi.caption}</div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function FleetMap() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="w-5 h-5 text-slate-500" />
          Fleet snapshot
        </CardTitle>
        <CardDescription>
          Per-store health right now. Time-to-cone, conversion, camera
          health, and weekly incidents in one row each.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {STORES.map((s) => {
            const badge = HEALTH_BADGE[s.health];
            return (
              <div
                key={s.id}
                className="rounded-lg border border-slate-200 bg-white p-3 space-y-2"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{s.id}</div>
                    <div className="text-xs text-slate-500">{s.city} · {s.format}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded border ${badge.tone}`}>
                    {badge.label}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <FleetStat label="t-to-cone" value={`${s.timeToCone}s`} tone={s.timeToCone <= 90 ? "good" : s.timeToCone <= 120 ? "warn" : "bad"} />
                  <FleetStat label="conv %" value={`${s.conversion}%`} tone={s.conversion >= 40 ? "good" : s.conversion >= 30 ? "warn" : "bad"} />
                  <FleetStat label="cams"   value={`${s.cameraHealth}%`} tone={s.cameraHealth >= 99 ? "good" : s.cameraHealth >= 95 ? "warn" : "bad"} />
                </div>
                <div className="text-xs text-slate-600 italic">{s.headline}</div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function FleetStat({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "bad" }) {
  const toneClass =
    tone === "good" ? "text-emerald-700"
      : tone === "warn" ? "text-amber-700"
        : "text-red-700";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`font-mono ${toneClass}`}>{value}</div>
    </div>
  );
}

// ─── Per-use-case sections ────────────────────────────────────────────

function SpillResponseSection() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Cone className="w-5 h-5" style={{ color: COLOR.spill }} />
              Spill response &amp; slip-claim defense
            </CardTitle>
            <CardDescription>
              Time from spill-detected to cone-detected, every store. Fleet
              target is 90 seconds. Every cycle is a row in Lakebase your
              carrier can audit.
            </CardDescription>
          </div>
          <CtaLink onClick={() => navigate("/spills")}>See live demo</CtaLink>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat label="Fleet avg t-to-cone" value="87s"  caption="target ≤ 90s"  tone="good" />
          <MiniStat label="Slowest store"        value="142s" caption="S-HOU-001"     tone="bad"  />
          <MiniStat label="Cycles documented"    value="412" caption="last 30 days"  tone="neutral" />
          <MiniStat label="Avg claim avoided"    value="$58K" caption="industry mid-five-fig"  tone="good" />
        </div>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={SPILL_RESPONSE}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="store" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} label={{ value: "seconds", angle: -90, position: "insideLeft", style: { fill: "#64748b", fontSize: 11 } }} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}s`} />
              <Bar dataKey="seconds" radius={[4, 4, 0, 0]}>
                {SPILL_RESPONSE.map((row, i) => (
                  <Cell
                    key={i}
                    fill={row.seconds <= 90 ? COLOR.ok : row.seconds <= 120 ? COLOR.warn : COLOR.bad}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function PlatesSection() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Car className="w-5 h-5" style={{ color: COLOR.plate }} />
              License plates &amp; drive-off prevention
            </CardTitle>
            <CardDescription>
              YOLO finds the vehicle, Claude vision reads the plate, the row
              joins to the POS. Unmatched fills become recoverable revenue.
            </CardDescription>
          </div>
          <CtaLink onClick={() => navigate("/plates")}>See live demo</CtaLink>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat label="Plate reads / day"      value="2.9K" caption="rolling 14-day" tone="neutral" />
          <MiniStat label="Drive-off candidates"   value="89"   caption="last 30 days"  tone="warn" />
          <MiniStat label="$ recovered YTD"        value="$184K" caption="join to POS"  tone="good" />
          <MiniStat label="Repeat-customer rate"   value="31%"  caption="plate join"    tone="good" />
        </div>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={PLATE_TIMESERIES}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" stroke="#64748b" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: "11px", color: "#64748b" }} />
              <Line yAxisId="left"  type="monotone" dataKey="captures" stroke={COLOR.plate} strokeWidth={2} dot={false} name="Plate captures" />
              <Line yAxisId="right" type="monotone" dataKey="flagged"  stroke={COLOR.bad}   strokeWidth={2} dot={false} name="Drive-off candidates" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ConversionSection() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" style={{ color: COLOR.guests }} />
              Pump → store conversion
            </CardTitle>
            <CardDescription>
              Unique tracks per zone. The denominator a fuel chain has never
              had. Per-store conversion ranges from 24% to 51%.
            </CardDescription>
          </div>
          <CtaLink onClick={() => navigate("/guests")}>See live demo</CtaLink>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat label="Fleet conversion"   value="38.4%" caption="12-week rolling" tone="good" />
          <MiniStat label="Best store"          value="51%"   caption="S-ATL-001"      tone="good" />
          <MiniStat label="Worst store"         value="24%"   caption="S-HOU-001"      tone="bad"  />
          <MiniStat label="Lunch-rush lift"     value="+6.2pp" caption="post staffing alert" tone="good" />
        </div>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={CONVERSION_BY_STORE}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="store" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} unit="%" />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}%`} />
              <Bar dataKey="conversion" radius={[4, 4, 0, 0]}>
                {CONVERSION_BY_STORE.map((row, i) => (
                  <Cell
                    key={i}
                    fill={row.conversion >= 40 ? COLOR.ok : row.conversion >= 30 ? COLOR.warn : COLOR.bad}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function CameraHealthSection() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CloudFog className="w-5 h-5" style={{ color: COLOR.fog }} />
              Camera clarity (the quality gate)
            </CardTitle>
            <CardDescription>
              Pillow + numpy PyFunc on every camera, every tick. Pennies per
              day, watches every other model on the platform.
            </CardDescription>
          </div>
          <CtaLink onClick={() => navigate("/clarity")}>See live demo</CtaLink>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat label="Cameras monitored" value="142"   caption="fleet-wide"            tone="neutral" />
          <MiniStat label="Cleaning tickets" value="8"     caption="auto-fired this week"  tone="warn"   />
          <MiniStat label="Fleet fogged %"   value="0.7%"  caption="under 5% threshold"    tone="good"   />
          <MiniStat label="Camera uptime"    value="99.7%" caption="rolling 30-day"        tone="good"   />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-slate-500">
              Fogged % by camera position
            </div>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={CAMERA_HEALTH} layout="vertical" margin={{ left: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" stroke="#64748b" tick={{ fontSize: 11 }} unit="%" />
                  <YAxis type="category" dataKey="position" stroke="#64748b" tick={{ fontSize: 11 }} width={88} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}%`} />
                  <Bar dataKey="fogged" fill={COLOR.fog} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wider text-slate-500">
              Open cleaning tickets
            </div>
            <RecentTicket title="S-DAL-001 · Canopy cam 3" body="Sustained fog 14% for 6 ticks. Wipe scheduled overnight." />
            <RecentTicket title="S-HOU-001 · Aisle dome A2" body="Condensation > 8% threshold. Maintenance route added." />
            <RecentTicket title="S-CHA-001 · Freezer dome F1" body="Repeat offender, 3rd ticket this month." badge="repeat" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RecentTicket({ title, body, badge }: { title: string; body: string; badge?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-900">{title}</span>
        {badge && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 uppercase tracking-wider">
            {badge}
          </span>
        )}
      </div>
      <div className="text-xs text-slate-600">{body}</div>
    </div>
  );
}

function FacialRecognitionSection() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ScanFace className="w-5 h-5" style={{ color: COLOR.faces }} />
              Facial recognition (banned / VIP / staff)
            </CardTitle>
            <CardDescription>
              InsightFace SCRFD + ArcFace, embeddings in Lakebase as
              pgvector. One Postgres for operations AND vector index.
            </CardDescription>
          </div>
          <CtaLink onClick={() => navigate("/faces")}>See live demo</CtaLink>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat label="Enrolled faces"        value="4,212" caption="staff + banned + VIP" tone="neutral" />
          <MiniStat label="Banned interventions"   value="11"   caption="last 7 days"          tone="warn" />
          <MiniStat label="VIP recognitions"       value="22"   caption="last 7 days"          tone="good" />
          <MiniStat label="Avg match latency"      value="1.2s" caption="pgvector + HNSW"      tone="good" />
        </div>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={FACE_MATCH_WEEKLY}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="week" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: "11px", color: "#64748b" }} />
              <Bar dataKey="staff"  stackId="x" fill="#3b82f6" name="Staff check-ins" />
              <Bar dataKey="vip"    stackId="x" fill="#f59e0b" name="VIP recognitions" />
              <Bar dataKey="banned" stackId="x" fill="#dc2626" name="Banned alerts" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function SpecialtyModelsSection() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-slate-500" />
          Specialty models
        </CardTitle>
        <CardDescription>
          Single-endpoint detectors with their own dollar line. Each one is
          a notebook deploy plus a row in <code className="text-xs">app.yml</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SpecialtyCard
            icon={AlertTriangle}
            color="#10b981"
            title="Slip &amp; fall"
            stat="3"
            statLabel="incidents auto-documented (30d)"
            blurb="Pair with spills for one row carrying hazard + incident timestamp + frame."
            onClick={() => navigate("/live")}
          />
          <SpecialtyCard
            icon={HardHat}
            color={COLOR.ppe}
            title="PPE compliance"
            stat="91%"
            statLabel="back-of-house weekly avg"
            blurb="Coaching trend, not punitive. Compliance up 4pp in 6 weeks at S-NAS-001."
            onClick={() => navigate("/live")}
          />
          <SpecialtyCard
            icon={ShieldAlert}
            color="#a855f7"
            title="Age-gate / vape"
            stat="17"
            statLabel="alerts at counter (7d)"
            blurb="Loss prevention at c-store counters. Manager intervenes before checkout."
            onClick={() => navigate("/live")}
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface SpecialtyCardProps {
  icon: typeof AlertTriangle;
  color: string;
  title: string;
  stat: string;
  statLabel: string;
  blurb: string;
  onClick: () => void;
}

function SpecialtyCard({ icon: Icon, color, title, stat, statLabel, blurb, onClick }: SpecialtyCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg border border-slate-200 bg-white p-4 hover:bg-slate-50 transition-colors"
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${color}20` }}
        >
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
        <span className="text-xs text-slate-500">See demo →</span>
      </div>
      <div className="text-2xl font-semibold text-slate-900">{stat}</div>
      <div className="text-sm text-slate-700 mt-0.5">{title}</div>
      <div className="text-xs text-slate-500">{statLabel}</div>
      <div className="text-xs text-slate-600 mt-2 leading-snug">{blurb}</div>
    </button>
  );
}

function SeeItLiveFooter() {
  const navigate = useNavigate();
  const items = [
    { label: "Live detection",      route: "/live",    color: "#dc2626" },
    { label: "Spill response",      route: "/spills",  color: COLOR.spill },
    { label: "License plates",      route: "/plates",  color: COLOR.plate },
    { label: "Guest counts",        route: "/guests",  color: COLOR.guests },
    { label: "Camera clarity",      route: "/clarity", color: COLOR.fog },
    { label: "Facial recognition",  route: "/faces",   color: COLOR.faces },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          See it live
        </CardTitle>
        <CardDescription>
          Every number above is a model running in your account. Click into
          any of these to watch frames become rows in real time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {items.map((i) => (
            <button
              key={i.route}
              type="button"
              onClick={() => navigate(i.route)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-left hover:bg-slate-50 transition-colors flex items-center gap-2"
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: i.color }} />
              <span className="truncate text-slate-800">{i.label}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────

interface MiniStatProps {
  label: string;
  value: string;
  caption: string;
  tone: "good" | "warn" | "bad" | "neutral";
}

function MiniStat({ label, value, caption, tone }: MiniStatProps) {
  const valueTone =
    tone === "good" ? "text-emerald-700"
      : tone === "warn" ? "text-amber-700"
        : tone === "bad" ? "text-red-700"
          : "text-slate-900";
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold tracking-tight ${valueTone}`}>{value}</div>
      <div className="text-[11px] text-slate-500 mt-0.5">{caption}</div>
    </div>
  );
}

function CtaLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-slate-600 hover:text-slate-900 hover:underline whitespace-nowrap shrink-0"
    >
      {children} →
    </button>
  );
}
