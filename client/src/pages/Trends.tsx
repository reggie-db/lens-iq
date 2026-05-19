import { useMemo } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@databricks/appkit-ui/react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// Trends view - longer-window aggregates: detection mix over a week and hourly
// detection counts for the day.

export function TrendsPage() {
  const weekParams = useMemo(() => ({ period: sql.string("week") }), []);
  const noParams = useMemo(() => ({}), []);

  const { data: weekly, loading: weekLoading } = useAnalyticsQuery("detections_summary", weekParams);
  const { data: hourly, loading: hourlyLoading } = useAnalyticsQuery("detections_hourly", noParams);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Detection Mix (7 days)</CardTitle>
          <CardDescription>Counts by class with week-over-week trend</CardDescription>
        </CardHeader>
        <CardContent>
          {weekLoading ? <Skeleton className="h-64 w-full" /> : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={weekly ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="object" stroke="#64748b" tick={{ fontSize: 12 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {(weekly ?? []).map((row, i) => <Cell key={i} fill={row.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detection Volume by Hour</CardTitle>
          <CardDescription>Last 24 hours</CardDescription>
        </CardHeader>
        <CardContent>
          {hourlyLoading ? <Skeleton className="h-64 w-full" /> : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={hourly ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" stroke="#64748b" tick={{ fontSize: 12 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#dc2626" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
