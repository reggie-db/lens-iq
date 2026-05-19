import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@databricks/appkit-ui/react";
import { Camera, Save } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { captureVideoFrame, requestCameraStream, stopMediaStream } from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";

// Live webcam preview that periodically grabs a frame, posts it to the
// configured detector serving endpoint via /api/detect, and overlays the
// returned bounding boxes on the video. A "Save snapshot" button captures the
// current frame with persist=true so it lands in the UC `frames` volume and
// `detections` table. The right-hand panel keeps a rolling window of the
// last `HISTORY_WINDOW_MS` of detections so the demo shows an aggregate
// "X detections in the last minute" view that doesn't reset on every frame.

const DEFAULT_FPS = 2;
const MIN_FPS = 1;
const MAX_FPS = 10;
const HISTORY_WINDOW_MS = 60_000;
const HISTORY_BUCKETS = 12;
const TOP_LABELS = 6;

interface HistoryEntry {
  ts: number;
  label: string;
}

interface LivePageProps {
  isActive: boolean;
}

export function LivePage({ isActive }: LivePageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const inFlightRef = useRef<boolean>(false);

  const [fps, setFps] = useState<number>(DEFAULT_FPS);
  const [status, setStatus] = useState<string>("");
  const [statusKind, setStatusKind] = useState<"idle" | "info" | "error">("idle");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (!isActive) return;

    const startCamera = async () => {
      const stream = await requestCameraStream("environment");
      if (!stream) {
        setStatus("Camera access denied");
        setStatusKind("error");
        return;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        trackRef.current = stream.getVideoTracks()[0] ?? null;
        const settings = trackRef.current?.getSettings();
        setStatus(`Camera ready (${settings?.width ?? "?"}x${settings?.height ?? "?"})`);
        setStatusKind("info");
        await videoRef.current.play().catch(() => undefined);
      }
    };
    void startCamera();

    return () => {
      stopMediaStream((videoRef.current?.srcObject as MediaStream | null) ?? null);
      if (videoRef.current) videoRef.current.srcObject = null;
      trackRef.current = null;
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const clamped = Math.max(MIN_FPS, Math.min(MAX_FPS, fps));
    const intervalMs = 1000 / clamped;

    const tick = async () => {
      if (inFlightRef.current || !videoRef.current) return;
      const frame = captureVideoFrame(videoRef.current, 0.7);
      if (!frame) return;
      inFlightRef.current = true;
      try {
        const result = await callDetector(frame);
        setDetections(result.detections);
        const ts = Date.now();
        const newEntries: HistoryEntry[] = result.detections.map((d) => ({ ts, label: d.label }));
        if (newEntries.length > 0) {
          setHistory((prev) => {
            const cutoff = ts - HISTORY_WINDOW_MS;
            const trimmed = prev.length > 0 && prev[0].ts < cutoff
              ? prev.filter((e) => e.ts >= cutoff)
              : prev;
            return [...trimmed, ...newEntries];
          });
        }
        setStatus(`Detected ${result.detections.length} object(s)`);
        setStatusKind("info");
      } catch (err) {
        setDetections([]);
        setStatus(err instanceof Error ? err.message : String(err));
        setStatusKind("error");
      } finally {
        inFlightRef.current = false;
      }
    };

    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [fps, isActive]);

  // Prune the history window and bump `now` once per second so per-bucket
  // counts/labels stay fresh even when the detector returns no detections.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      const cutoff = Date.now() - HISTORY_WINDOW_MS;
      setHistory((prev) => (prev.length > 0 && prev[0].ts < cutoff ? prev.filter((e) => e.ts >= cutoff) : prev));
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (detections.length === 0) return;
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
    ctx.font = `${Math.max(14, Math.round(canvas.width / 60))}px sans-serif`;
    for (const d of detections) {
      const [x1, y1, x2, y2] = d.bbox;
      ctx.strokeStyle = "#dc2626";
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = `${d.label} ${(d.confidence * 100).toFixed(0)}%`;
      const padding = 4;
      const labelHeight = Math.max(18, Math.round(canvas.width / 50));
      const tw = ctx.measureText(label).width + padding * 2;
      ctx.fillStyle = "rgba(220, 38, 38, 0.9)";
      ctx.fillRect(x1, Math.max(0, y1 - labelHeight), tw, labelHeight);
      ctx.fillStyle = "white";
      ctx.fillText(label, x1 + padding, Math.max(labelHeight - padding, y1 - padding));
    }
  }, [detections]);

  const handleSaveSnapshot = async () => {
    if (!videoRef.current || saving) return;
    const frame = captureVideoFrame(videoRef.current, 0.85);
    if (!frame) {
      toast.error("No frame to capture yet.");
      return;
    }
    setSaving(true);
    try {
      const result = await callDetector(frame, { persist: true });
      if (result.saved) {
        toast.success(`Saved ${result.saved.frame_id} with ${result.detections.length} detection(s)`);
      } else {
        toast.error("Detection ran but persistence failed (see server logs).");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setSaving(false);
    }
  };

  const stats = useMemo(() => {
    const cutoff = now - HISTORY_WINDOW_MS;
    const recent = history.filter((e) => e.ts >= cutoff);

    const counts = new Map<string, number>();
    for (const e of recent) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);

    const byLabel = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    const bucketMs = HISTORY_WINDOW_MS / HISTORY_BUCKETS;
    const buckets = Array.from({ length: HISTORY_BUCKETS }, (_, i) => {
      const start = cutoff + i * bucketMs;
      const end = start + bucketMs;
      const secondsAgo = Math.round((now - end) / 1000);
      return {
        label: secondsAgo <= 0 ? "now" : `-${secondsAgo}s`,
        count: 0,
      };
    });
    for (const e of recent) {
      const idx = Math.min(HISTORY_BUCKETS - 1, Math.max(0, Math.floor((e.ts - cutoff) / bucketMs)));
      buckets[idx].count += 1;
    }

    return { total: recent.length, byLabel, buckets };
  }, [history, now]);

  const currentFrameLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }, [detections]);

  const windowSeconds = Math.round(HISTORY_WINDOW_MS / 1000);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="w-5 h-5" /> Live Detection
          </CardTitle>
          <CardDescription>
            Frames are sent to the YOLO detector endpoint and bounding boxes are
            overlaid here in realtime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
            <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-contain" />
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div className="space-y-2">
              <Label htmlFor="fps">Frame rate (FPS)</Label>
              <Input
                id="fps"
                type="number"
                min={MIN_FPS}
                max={MAX_FPS}
                value={fps}
                onChange={(e) => setFps(parseInt(e.target.value, 10) || DEFAULT_FPS)}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <div
                className={
                  "text-xs break-words " +
                  (statusKind === "error"
                    ? "text-red-600 font-medium"
                    : statusKind === "info"
                    ? "text-slate-600"
                    : "text-slate-400")
                }
              >
                {status || "Initializing camera..."}
              </div>
            </div>
            <Button onClick={handleSaveSnapshot} disabled={saving} className="gap-2">
              <Save className="w-4 h-4" />
              {saving ? "Saving..." : "Save snapshot"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detections - last {windowSeconds}s</CardTitle>
          <CardDescription>Rolling window across the live feed</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold text-slate-900 tabular-nums">{stats.total}</span>
            <span className="text-sm text-slate-500">detections in past {windowSeconds}s</span>
          </div>

          <div className="h-24 -mx-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.buckets} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} width={24} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: "rgba(220, 38, 38, 0.08)" }}
                  contentStyle={{ fontSize: 12, padding: "4px 8px" }}
                  labelFormatter={(v) => `t=${v}`}
                />
                <Bar dataKey="count" fill="#dc2626" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">By label</div>
            <div className="space-y-1.5">
              {stats.byLabel.length === 0 && (
                <div className="text-sm text-slate-500">No detections yet.</div>
              )}
              {stats.byLabel.slice(0, TOP_LABELS).map((row) => {
                const pct = stats.total > 0 ? (row.count / stats.total) * 100 : 0;
                return (
                  <div key={row.label} className="space-y-0.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize text-slate-700">{row.label}</span>
                      <span className="tabular-nums text-slate-600">{row.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full bg-red-600 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {currentFrameLabels.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Current frame</div>
              <div className="flex flex-wrap gap-1.5">
                {currentFrameLabels.map((row) => (
                  <Badge key={row.label} variant="outline" className="gap-1">
                    <span className="capitalize">{row.label}</span>
                    <span className="text-slate-500 tabular-nums">x{row.count}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
