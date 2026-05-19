import { useMemo, useState } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from "@databricks/appkit-ui/react";
import { AlertTriangle, CheckCircle, MapPin, Thermometer } from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { TemperatureChart } from "../components/TemperatureChart";

// Overview page - KPI tiles, temperature trend chart for a selected device, and
// the current-status side panel. All numbers come from analytics queries that
// hit `reggie_pierce_7405614800873570.pizza_vision.*`.

const TIME_RANGES = [
  { value: "24h", label: "24 Hours",  hours: 24 },
  { value: "7d",  label: "7 Days",    hours: 24 * 7 },
  { value: "30d", label: "30 Days",   hours: 24 * 30 },
] as const;

type TimeRangeKey = (typeof TIME_RANGES)[number]["value"];

const _CHART_TOOLTIP_STYLE = {
  backgroundColor: "white",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  fontSize: "12px",
  color: "#0f172a",
} as const;

export function OverviewPage() {
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("24h");

  const noParams = useMemo(() => ({}), []);
  const { data: devices, loading: devicesLoading } = useAnalyticsQuery("devices", noParams);
  const { data: stats } = useAnalyticsQuery("device_stats", noParams);
  const { data: cameras } = useAnalyticsQuery("cameras_online", noParams);
  const { data: traffic } = useAnalyticsQuery("vehicle_traffic", noParams);

  const effectiveDevice = selectedDevice || devices?.[0]?.id || "";
  const selectedDeviceData = devices?.find((d) => d.id === effectiveDevice);
  const hours = TIME_RANGES.find((r) => r.value === timeRange)?.hours ?? 24;

  const historyParams = useMemo(
    () => ({ deviceId: sql.string(effectiveDevice), hours: sql.number(hours) }),
    [effectiveDevice, hours],
  );
  const { data: history } = useAnalyticsQuery("device_history", historyParams, {
    autoStart: !!effectiveDevice,
  });

  const summary = stats?.[0];

  if (devicesLoading && !devices) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Devices</CardDescription>
            <CardTitle className="text-slate-900">{summary?.totalDevices ?? 0}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <CheckCircle className="w-4 h-4 text-green-600" />
              {summary?.normalCount ?? 0} operational
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Average Temperature</CardDescription>
            <CardTitle className="text-slate-900">{summary?.avgTemp ?? "--"}°F</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Thermometer className="w-4 h-4" />
              Across all locations
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Warnings</CardDescription>
            <CardTitle className="text-amber-600">{summary?.warningCount ?? 0}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              Requires attention
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Critical Alerts</CardDescription>
            <CardTitle className="text-red-600">{summary?.criticalCount ?? 0}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              Immediate action needed
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Online Cameras Frequency</CardTitle>
            <CardDescription>Last 24 hours</CardDescription>
          </CardHeader>
          <CardContent className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cameras ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" stroke="#64748b" tick={{ fontSize: 12, fill: "#64748b" }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12, fill: "#64748b" }} />
                <Tooltip contentStyle={_CHART_TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: "12px", color: "#64748b" }} />
                <Line type="monotone" dataKey="cameras" stroke="#3b82f6" strokeWidth={2} dot={{ fill: "#3b82f6", r: 4 }} name="Cameras Online" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Overall Vehicle Traffic</CardTitle>
            <CardDescription>Last 24 hours</CardDescription>
          </CardHeader>
          <CardContent className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={traffic ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" stroke="#64748b" tick={{ fontSize: 12, fill: "#64748b" }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12, fill: "#64748b" }} />
                <Tooltip contentStyle={_CHART_TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: "12px", color: "#64748b" }} />
                <Bar dataKey="vehicles" fill="#10b981" name="Vehicles Detected" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Temperature Fluctuations</CardTitle>
                <CardDescription className="mt-1">
                  {selectedDeviceData?.name ?? "--"} - {selectedDeviceData?.location ?? ""}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Select value={effectiveDevice} onValueChange={setSelectedDevice}>
                  <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select device" /></SelectTrigger>
                  <SelectContent>
                    {(devices ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRangeKey)}>
                  <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIME_RANGES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <TemperatureChart data={history ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Current Status</CardTitle>
            <CardDescription>Real-time device readings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Row label="Current Temperature" value={
                <span className={
                  selectedDeviceData?.status === "critical" ? "text-red-600"
                    : selectedDeviceData?.status === "warning" ? "text-amber-600"
                      : "text-green-600"
                }>{selectedDeviceData?.currentTemp ?? "--"}°F</span>
              } />
              <Row label="Status" value={
                <Badge variant={
                  selectedDeviceData?.status === "critical" ? "destructive"
                    : selectedDeviceData?.status === "warning" ? "default"
                      : "outline"
                }>{selectedDeviceData?.status ?? "--"}</Badge>
              } />
              <Row label="Last Update" value={selectedDeviceData?.lastUpdate ?? "--"} />
              <Row label="Device ID" value={<span className="font-mono">{selectedDeviceData?.id ?? "--"}</span>} />
            </div>

            <div className="pt-4 border-t">
              <h4 className="text-sm mb-3">Temperature Ranges</h4>
              <div className="space-y-2">
                <Row label="Safe Range"     value={<span className="text-green-600">65°F - 80°F</span>} small />
                <Row label="Warning Range"  value={<span className="text-amber-600">80°F - 90°F</span>} small />
                <Row label="Critical Range" value={<span className="text-red-600">&gt; 90°F</span>} small />
              </div>
            </div>

            <div className="pt-4 border-t">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
                <div className="text-sm text-slate-600">{selectedDeviceData?.location ?? "--"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, small }: { label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={small ? "text-sm text-slate-600" : "text-sm text-slate-600"}>{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}
