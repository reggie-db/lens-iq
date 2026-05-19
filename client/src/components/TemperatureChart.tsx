import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TemperatureDataPoint } from "../lib/queries";

// Renders the temperature/humidity history for a single device. Pure
// presentation - the parent supplies the rows already filtered + sorted.

interface TemperatureChartProps {
  data: TemperatureDataPoint[];
}

export function TemperatureChart({ data }: TemperatureChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="tempGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#dc2626" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 12, fill: "#64748b" }} />
        <YAxis stroke="#64748b" tick={{ fontSize: 12, fill: "#64748b" }} domain={["dataMin - 5", "dataMax + 5"]} />
        <Tooltip contentStyle={{ backgroundColor: "white", border: "1px solid #e2e8f0", borderRadius: "6px", fontSize: "12px" }} />
        <ReferenceLine y={80} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: "Warning", fontSize: 11, fill: "#f59e0b" }} />
        <ReferenceLine y={90} stroke="#dc2626" strokeDasharray="4 4" label={{ value: "Critical", fontSize: 11, fill: "#dc2626" }} />
        <Area type="monotone" dataKey="temperature" stroke="#dc2626" strokeWidth={2} fill="url(#tempGradient)" name="Temperature (°F)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
