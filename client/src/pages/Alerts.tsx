import { useMemo } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@databricks/appkit-ui/react";
import { AlertTriangle, Bell, CheckCircle, Info } from "lucide-react";

// Recent alert events plus a static rule list. The original demo used a Jolt
// rules editor; here we keep that explanatory panel and stream actual alerts
// from the `alerts` table.

const SEVERITY_ICON = {
  critical: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
} as const;

const SEVERITY_TONE = {
  critical: "text-red-600",
  warning: "text-amber-600",
  info: "text-sky-600",
} as const;

const _RULES = [
  { id: "temperature_critical", message: "Refrigeration temperature > 90°F" },
  { id: "temperature_warning", message: "Refrigeration temperature > 80°F" },
  { id: "pizza_low_stock", message: "Pizza inventory dropped below 25%" },
  { id: "camera_offline", message: "Camera offline > 5 minutes" },
  { id: "vehicle_dwell_long", message: "Vehicle dwell time > 8 minutes at drive-through" },
  { id: "unrecognized_plate", message: "Unrecognized license plate at restricted lane" },
];

export function AlertsPage() {
  const params = useMemo(() => ({ max_rows: sql.number(50) }), []);
  const { data: alerts, loading, error } = useAnalyticsQuery("alerts", params);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Bell className="w-5 h-5" /> Recent Alerts</CardTitle>
          <CardDescription>Last 50 rule-engine events</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <Skeleton className="h-64 w-full" />}
          {error && <div className="text-destructive">{error}</div>}
          {!loading && !error && (
            <div className="space-y-3">
              {(alerts ?? []).map((a) => {
                const Icon = SEVERITY_ICON[a.severity] ?? Info;
                return (
                  <div key={a.id} className="flex items-start gap-3 p-3 rounded-lg border bg-slate-50 border-slate-200">
                    <Icon className={`w-4 h-4 mt-0.5 ${SEVERITY_TONE[a.severity] ?? ""}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-slate-900">{a.message}</span>
                        <Badge variant={a.acknowledged ? "outline" : "default"} className="shrink-0">
                          {a.acknowledged ? <><CheckCircle className="w-3 h-3 mr-1" /> ack</> : "open"}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-500 mt-1">{a.storeName} - {a.ts}</div>
                    </div>
                  </div>
                );
              })}
              {(alerts?.length ?? 0) === 0 && (
                <div className="text-sm text-slate-500">No alerts.</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active Rules</CardTitle>
          <CardDescription>Static configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {_RULES.map((r) => (
              <li key={r.id} className="flex flex-col">
                <span className="font-mono text-xs text-slate-500">{r.id}</span>
                <span className="text-slate-800">{r.message}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
