import { useMemo } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@databricks/appkit-ui/react";
import { Car, Hash, TrendingUp } from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// License plate analytics: state distribution chart, recent captures, and
// summary statistics.

export function PlatesPage() {
  const periodParams = useMemo(() => ({ period: sql.string("today") }), []);
  const recentParams = useMemo(() => ({ max_rows: sql.number(20) }), []);
  const noParams = useMemo(() => ({}), []);

  const { data: distribution, loading: distLoading } = useAnalyticsQuery("plate_distribution", periodParams);
  const { data: recent } = useAnalyticsQuery("plate_recent", recentParams);
  const { data: statsRows } = useAnalyticsQuery("plate_stats", noParams);

  const stats = statsRows?.[0];

  if (distLoading && !distribution) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Detected (24h)</CardDescription>
            <CardTitle className="text-slate-900">{stats?.totalDetected?.toLocaleString() ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm text-slate-600">
            <Car className="w-4 h-4" /> Across all locations
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Unique States</CardDescription>
            <CardTitle className="text-slate-900">{stats?.uniqueStates ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm text-slate-600">
            <Hash className="w-4 h-4" /> distinct plates
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Average / hour</CardDescription>
            <CardTitle className="text-slate-900">{stats?.averagePerHour ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm text-slate-600">
            rolling 24h
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Trend vs. yesterday</CardDescription>
            <CardTitle className="text-slate-900">{stats?.trend ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm text-slate-600">
            <TrendingUp className="w-4 h-4" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>State Distribution</CardTitle>
            <CardDescription>Today</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={distribution ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="state" stroke="#64748b" tick={{ fontSize: 12 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                <Tooltip contentStyle={{ backgroundColor: "white", border: "1px solid #e2e8f0", borderRadius: "6px", fontSize: "12px" }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {(distribution ?? []).map((row, i) => <Cell key={i} fill={row.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Plates</CardTitle>
            <CardDescription>Latest captures</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(recent ?? []).map((p) => (
                <div key={p.id} className="p-3 rounded-lg border bg-slate-50 border-slate-200">
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{p.state}</Badge>
                      <span className="font-mono text-slate-900">{p.plateNumber}</span>
                    </div>
                    <span className="text-xs text-slate-500">{p.time}</span>
                  </div>
                  <p className="text-sm text-slate-600">{p.location}</p>
                  <div className="text-xs text-slate-500 mt-1">{p.confidence}% confidence</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
