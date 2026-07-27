import { useMemo, useState } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from "@databricks/appkit-ui/react";
import { Pizza, Truck } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Inventory view - pizza stock level + truck parking capacity for the four
// flagship stores. Same data layout as the original Figma demo but backed by
// the synthetic `inventory` table.

const STORES = [
  { id: "S-ATL-001", name: "Store #1247 - Atlanta" },
  { id: "S-ATL-002", name: "Store #1248 - Atlanta North" },
  { id: "S-DAL-001", name: "Store #2145 - Dallas" },
  { id: "S-HOU-001", name: "Store #2389 - Houston" },
] as const;

const DEFAULT_STORE_ID = STORES[0].id;

export function InventoryPage() {
  const [storeId, setStoreId] = useState<string>(DEFAULT_STORE_ID);
  const params = useMemo(() => ({ storeId: sql.string(storeId) }), [storeId]);

  const { data: pizza, loading: pizzaLoading } = useAnalyticsQuery("inventory_pizza", params);
  const { data: truck, loading: truckLoading } = useAnalyticsQuery("inventory_truck", params);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="text-sm text-slate-600">Store</span>
        <Select value={storeId} onValueChange={setStoreId}>
          <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STORES.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Pizza className="w-5 h-5 text-red-600" /> Pizza Inventory</CardTitle>
            <CardDescription>Stock percentage, last 12 hours</CardDescription>
          </CardHeader>
          <CardContent className="h-[280px]">
            {pizzaLoading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pizza ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 12 }} domain={[0, 100]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="percentage" stroke="#dc2626" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Truck className="w-5 h-5 text-blue-600" /> Truck Parking Capacity</CardTitle>
            <CardDescription>Utilization percentage, last 12 hours</CardDescription>
          </CardHeader>
          <CardContent className="h-[280px]">
            {truckLoading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={truck ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 12 }} domain={[0, 100]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
