import { useEffect, useMemo, useRef, useState } from "react";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { sql } from "@databricks/appkit-ui/js";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@databricks/appkit-ui/react";
import { Activity, Camera, Workflow } from "lucide-react";
import type { PipelineDetection, PipelineFrame } from "../lib/queries";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";

// Continuous detection pipeline view.
//
// Reads from the gold `pipeline_frames` table which is produced by the
// Lakeflow Spark Declarative Pipeline (see pipelines/pizza_vision_pipeline.py).
// The pipeline ingests raw frames via Auto Loader from frames_inbox, dedupes
// to one frame per 10s per camera, and invokes the YOLO serving endpoint.
//
// Each card shows the original frame served from /api/files/inbox/raw with
// bounding boxes drawn client-side from the structured `detections` column.
// The whole grid remounts every REFRESH_MS so new frames appear automatically.

const REFRESH_MS = 4000;
const MAX_FRAMES = 12;

interface FrameCardProps {
  frame: PipelineFrame;
}

function _formatBytes(bytes: number): string {
  if (!bytes) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function _parseDetections(jsonStr: string): PipelineDetection[] {
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? (parsed as PipelineDetection[]) : [];
  } catch {
    return [];
  }
}

function FrameCard({ frame }: FrameCardProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  // The pipeline_frames query returns the full UC volume source_path; the
  // Files plugin's /api/files/inbox/raw expects the path *relative* to the
  // volume root (i.e. `<camera>/<file_name>`).
  const inboxRelativePath = `${frame.camera}/${frame.file_name}`;
  const imgUrl = `/api/files/inbox/raw?path=${encodeURIComponent(inboxRelativePath)}`;

  const detections = useMemo(
    () => _parseDetections(frame.detections_json),
    [frame.detections_json],
  );

  // drawBboxOverlay normally takes a <video> + intrinsic videoSize; here
  // we pass the still image's natural pixels instead so the canvas sizes
  // to the actual image, not the CSS-fitted display size.
  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      detections.map((d) => ({
        bbox: d.bbox,
        color: "#dc2626",
        label: `${d.label} ${(d.confidence * 100).toFixed(0)}%`,
        fillAlpha: 0,
        labelAlpha: 0.85,
      })),
    [detections],
  );

  useEffect(() => {
    if (!loaded || !imgRef.current) return;
    const img = imgRef.current;
    drawBboxOverlay(
      canvasRef.current,
      null,
      { w: img.naturalWidth, h: img.naturalHeight },
      overlayBoxes,
    );
  }, [overlayBoxes, loaded]);

  return (
    <Card>
      <CardHeader className="p-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-slate-500" />
            {frame.camera}
          </span>
          <Badge variant={frame.num_detections > 0 ? "default" : "outline"}>
            {frame.num_detections} obj
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          {frame.frame_ts} ({_formatBytes(frame.size_bytes)})
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="relative bg-black rounded overflow-hidden aspect-video">
          <img
            ref={imgRef}
            src={imgUrl}
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(false)}
            className="absolute inset-0 w-full h-full object-contain"
            alt={frame.file_name}
          />
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        </div>
        {detections.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {detections.slice(0, 6).map((d, i) => (
              <Badge key={i} variant="outline" className="text-xs">
                {d.label} {(d.confidence * 100).toFixed(0)}%
              </Badge>
            ))}
            {detections.length > 6 && (
              <Badge variant="outline" className="text-xs">
                +{detections.length - 6} more
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function _StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
        <div className="text-2xl font-semibold text-slate-900">{value}</div>
        {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// Inner component re-mounts on each tick so useAnalyticsQuery re-runs and the
// grid stays close-to-live (~REFRESH_MS lag).
function PipelinePageInner() {
  const framesParams = useMemo(() => ({ max_rows: sql.number(MAX_FRAMES) }), []);
  const noParams = useMemo(() => ({}), []);

  const { data: frames, loading } = useAnalyticsQuery("pipeline_frames", framesParams);
  const { data: stats } = useAnalyticsQuery("pipeline_stats", noParams);

  const summary = stats?.[0];
  const dedupeRatio = summary && summary.raw_frames > 0
    ? `${((summary.deduped_frames / summary.raw_frames) * 100).toFixed(0)}%`
    : "--";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <Workflow className="w-5 h-5" /> Continuous detection pipeline
        </h2>
        <p className="text-sm text-slate-600">
          Frames stream in from the cameras, get filtered to one every 10s per
          camera, then run through the detection model. New frames appear here
          within {(REFRESH_MS / 1000).toFixed(0)}s.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <_StatTile label="Raw frames" value={summary?.raw_frames ?? "--"} />
        <_StatTile
          label="After dedupe"
          value={summary?.deduped_frames ?? "--"}
          hint={`${dedupeRatio} kept`}
        />
        <_StatTile label="Detected" value={summary?.processed_frames ?? "--"} />
        <_StatTile label="Objects total" value={summary?.total_detections ?? "--"} />
        <_StatTile
          label="Cameras live"
          value={summary?.cameras_active ?? "--"}
          hint={summary?.last_processed_at ?? undefined}
        />
      </div>

      {loading && !frames && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-72 w-full" />
          ))}
        </div>
      )}

      {frames && frames.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-slate-500">
            <Activity className="w-8 h-8 mx-auto mb-2 text-slate-400" />
            <div className="font-medium">No frames yet</div>
            <div className="text-xs mt-1">
              Run <code>databricks bundle run pizza_vision_simulate -t dev</code>{" "}
              to drop frames into <code>frames_inbox</code>, or write your own
              producer that targets that UC volume.
            </div>
          </CardContent>
        </Card>
      )}

      {frames && frames.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {frames.map((f) => (
            <FrameCard key={f.source_path + f.pipeline_ts} frame={f} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PipelinePage() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return <PipelinePageInner key={tick} />;
}
