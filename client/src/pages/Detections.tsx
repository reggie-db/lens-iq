import { useEffect, useMemo, useState } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@databricks/appkit-ui/react";
import { Camera, Car, Package, Pizza, TrendingUp, Truck, Users } from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// Detections view - replicates the original DetectionViewer with two changes:
//   1. Aggregate cards/charts come from analytics SQL queries.
//   2. The realtime detection feed comes from /api/detections/stream (SSE
//      backed by the analytics plugin polling the detections table).

interface StreamEvent {
  id: number;
  frame_id: string;
  ts: string;
  store_id: string;
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
}

const _ICON_MAP: Record<string, typeof Car> = {
  Car,
  Users,
  Truck,
  Package,
  Pizza,
};

const MAX_STREAM_EVENTS = 12;

export function DetectionsPage() {
  const summaryParams = useMemo(() => ({ period: sql.string("today") }), []);
  const recentParams = useMemo(() => ({ max_rows: sql.number(20) }), []);
  const noParams = useMemo(() => ({}), []);

  const { data: summary, loading: summaryLoading } = useAnalyticsQuery("detections_summary", summaryParams);
  const { data: hourly } = useAnalyticsQuery("detections_hourly", noParams);
  const { data: recent } = useAnalyticsQuery("detections_recent", recentParams);

  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);

  // SSE subscription is always on: the page mounts -> open EventSource,
  // unmount -> close. /api/detections/stream is backed by the analytics
  // plugin polling the detections table every POLL_INTERVAL_MS.
  useEffect(() => {
    const evt = new EventSource("/api/detections/stream");
    evt.addEventListener("detection", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as StreamEvent;
        setStreamEvents((prev) => [payload, ...prev].slice(0, MAX_STREAM_EVENTS));
      } catch {
        // Swallow malformed payloads; the stream is best-effort.
      }
    });
    return () => evt.close();
  }, []);

  if (summaryLoading && !summary) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {(summary ?? []).map((item) => {
          const Icon = _ICON_MAP[item.icon] ?? Package;
          const isPositive = item.trend.startsWith("+");
          return (
            <Card key={item.object}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${item.color}20` }}>
                    <Icon className="w-5 h-5" style={{ color: item.color }} />
                  </div>
                  <Badge variant={isPositive ? "default" : "outline"} className="gap-1">
                    <TrendingUp className={`w-3 h-3 ${isPositive ? "" : "rotate-180"}`} />
                    {item.trend}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-slate-900">{item.count.toLocaleString()}</CardTitle>
                <CardDescription className="mt-1">{item.object} detected (24h)</CardDescription>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Hourly Detection Activity</CardTitle>
            <CardDescription>Detections over the last 24 hours</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={hourly ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" stroke="#64748b" tick={{ fontSize: 12 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                <Tooltip contentStyle={{ backgroundColor: "white", border: "1px solid #e2e8f0", borderRadius: "6px", fontSize: "12px" }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {(hourly ?? []).map((_, i) => <Cell key={i} fill="#dc2626" />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Camera className="w-5 h-5" /> Recent Detections</CardTitle>
            <CardDescription>Latest from the warehouse</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {(recent ?? []).map((d) => (
                <div key={d.id} className="p-3 rounded-lg border bg-slate-50 border-slate-200">
                  <div className="flex items-start justify-between mb-1">
                    <span className="text-slate-900">{d.type}</span>
                    <span className="text-xs text-slate-500">{d.time}</span>
                  </div>
                  <p className="text-sm mb-2 text-slate-600">{d.location}</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 rounded-full h-1.5 bg-slate-200">
                      <div className="bg-green-600 h-1.5 rounded-full" style={{ width: `${d.confidence}%` }} />
                    </div>
                    <span className="text-xs text-slate-600">{d.confidence}%</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="w-5 h-5" />
            Live Detection Stream
          </CardTitle>
          <CardDescription>
            Streaming new detections from /api/detections/stream
          </CardDescription>
        </CardHeader>
        <CardContent>
          {streamEvents.length === 0 ? (
            <div className="text-sm text-slate-500">No live events yet.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {streamEvents.map((e) => (
                <div key={e.id} className="p-3 rounded-lg border border-slate-200 bg-white">
                  <div className="flex items-start justify-between">
                    <span className="font-medium text-slate-900 capitalize">{e.label}</span>
                    <Badge variant="outline">{Math.round(e.confidence * 100)}%</Badge>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{e.ts}</div>
                  <div className="mt-1 text-xs text-slate-500">store: {e.store_id}</div>
                  <div className="mt-1 text-xs font-mono text-slate-400">frame: {e.frame_id}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
