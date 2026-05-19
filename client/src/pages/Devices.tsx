import { useMemo } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@databricks/appkit-ui/react";
import { Cpu, MapPin } from "lucide-react";

// Grid of all monitored devices with current temperature and status badge.

export function DevicesPage() {
  const params = useMemo(() => ({}), []);
  const { data: devices, loading, error } = useAnalyticsQuery("devices", params);

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (error) return <div className="text-destructive">{error}</div>;
  if (!devices?.length) return <div className="text-slate-500">No devices found.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {devices.map((device) => (
        <Card key={device.id}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Cpu className="w-4 h-4 text-slate-500" />
                {device.name}
              </CardTitle>
              <Badge variant={
                device.status === "critical" ? "destructive"
                  : device.status === "warning" ? "default"
                    : "outline"
              }>{device.status}</Badge>
            </div>
            <CardDescription className="flex items-center gap-1 text-xs">
              <MapPin className="w-3 h-3" /> {device.location}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-semibold text-slate-900">{device.currentTemp}°F</span>
              <span className="text-xs text-slate-500">{device.lastUpdate}</span>
            </div>
            <div className="text-xs font-mono text-slate-400">{device.id}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
