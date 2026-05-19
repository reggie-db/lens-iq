import { useMemo, useState } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Skeleton,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@databricks/appkit-ui/react";
import { Search } from "lucide-react";

// Data search - filters the detections table by label substring.

export function SearchPage() {
  const [query, setQuery] = useState<string>("");
  const params = useMemo(
    () => ({ search: sql.string(query.trim()), max_rows: sql.number(200) }),
    [query],
  );
  const { data, loading, error } = useAnalyticsQuery("data_search", params);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Search className="w-5 h-5" /> Data Search</CardTitle>
        <CardDescription>Filter detection events by label</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          placeholder="e.g. pizza, vehicle, truck"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {loading && <Skeleton className="h-32 w-full" />}
        {error && <div className="text-destructive">{error}</div>}
        {!loading && !error && (
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((row) => (
                  <TableRow key={`${row.kind}-${row.id}`}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell>{row.store}</TableCell>
                    <TableCell className="font-mono text-xs">{row.ts}</TableCell>
                    <TableCell className="text-right">{row.confidence}%</TableCell>
                  </TableRow>
                ))}
                {(data?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-slate-500 py-6">
                      No matching events.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
