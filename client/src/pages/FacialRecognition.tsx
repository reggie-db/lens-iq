import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Spinner,
} from "@databricks/appkit-ui/react";
import { Loader2, ShieldAlert, Star, Trash2, UserCheck, UserPlus, X } from "lucide-react";
import { captureVideoFrame, captureVideoFrameForDetection, resizeDataUrl } from "../lib/camera";
import { drawBboxOverlay, type OverlayBox } from "../lib/bbox-overlay";
import { useWebcamStream } from "../lib/useWebcamStream";
import { useDetectionLoop } from "../lib/useDetectionLoop";
import { EndpointNotDeployedError, fetchJson } from "../lib/serving-status";
import { ImageModal } from "../components/ImageModal";

// Facial Recognition view.
//
// The pipeline:
//   1. Operator enrolls known faces (banned shoppers, VIP regulars, on-duty
//      staff) by uploading a clear photo + name + role. The server crops
//      the largest face, runs InsightFace buffalo_l for the 512-d ArcFace
//      embedding, and stores it in postgres alongside a small thumbnail.
//   2. The webcam streams to /api/face-match every tick. The endpoint
//      detects all faces in the frame, embeds each one, and runs a
//      pgvector cosine search against the enrolled set. Matches above
//      the threshold get persisted into `face_matches` (deduped per
//      face_id for 30s) so the recent-matches stream stays signal-only.
//   3. Detected faces overlay the webcam with role-coloured bboxes
//      (red for banned, gold for VIP, blue for staff, slate for unknown).
//      Matched faces show name + similarity %, unknowns just show a
//      "?" pill.
//
// Roles control bbox colour AND the page's alerting posture - matched
// "banned" faces blink the badge red so the booth presenter can show
// "this person is gone five seconds after they walk in".

// The face-recognition serving endpoint runs InsightFace detection +
// ArcFace embedding for every visible face, plus a pgvector cosine
// query per face. Warm-state latency is ~400-800ms for 1-2 faces and
// can spike to 1.5s+ on 3-4 faces or after a cold-start. We pick:
//   - intervalMs = 800ms  (~1.25 fps ceiling)
//   - cooldownMs = 600ms  (always at least 600ms between completions)
// so the loop never strobes "as fast as the endpoint will answer".
// The cooldown is the dominant constraint on slow ticks; intervalMs
// keeps fast warm ticks from going too fast.
const TICK_INTERVAL_MS = 800;
const TICK_COOLDOWN_MS = 600;
// Recent-matches list. Loaded eagerly on mount (independent of `isActive`)
// and grows via infinite scroll: a sentinel at the bottom of the scroll
// container pages in the next chunk using keyset pagination on
// (ts, id). Stays bounded only by what the user scrolls through.
const RECENT_PAGE_SIZE = 50;

type Role = "banned" | "vip" | "staff";

const ROLE_META: Record<Role, { color: string; label: string; icon: typeof ShieldAlert }> = {
  banned: { color: "#dc2626", label: "Banned", icon: ShieldAlert },
  vip: { color: "#f59e0b", label: "VIP", icon: Star },
  staff: { color: "#0ea5e9", label: "Staff", icon: UserCheck },
};
const UNKNOWN_COLOR = "#64748b";

interface EnrolledFace {
  id: number;
  name: string;
  role: Role;
  image: string | null;
  det_score: number | null;
  created_at: string;
}

interface MatchRow {
  id: number;
  ts: string;
  source_id: string;
  face_id: number | null;
  name: string;
  role: Role;
  similarity: number;
  bbox_x1: number;
  bbox_y1: number;
  bbox_x2: number;
  bbox_y2: number;
  /** Snapshot of the live frame at match time. */
  frame_image: string | null;
  /** Reference photo from the enrolled `faces` row (LEFT JOIN). */
  enrolled_image: string | null;
}

interface MatchFromTick {
  face_id: number;
  name: string;
  role: Role;
  similarity: number;
  image: string | null;
}

interface FaceFromTick {
  bbox: [number, number, number, number];
  det_score: number;
  match: MatchFromTick | null;
}

interface FacialRecognitionPageProps {
  isActive: boolean;
}

interface ImagePreview {
  src: string;
  alt: string;
  caption?: string;
  mirror?: boolean;
}

export function FacialRecognitionPage({ isActive }: FacialRecognitionPageProps) {
  const [enrolled, setEnrolled] = useState<EnrolledFace[]>([]);
  const [enrolledLoading, setEnrolledLoading] = useState(false);
  const [recent, setRecent] = useState<MatchRow[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentHasMore, setRecentHasMore] = useState(true);
  const [preview, setPreview] = useState<ImagePreview | null>(null);

  // Re-entrancy latch for the infinite-scroll pager. IntersectionObserver
  // can fire twice in the same tick (scroll inertia + layout settle),
  // and React state updates aren't atomic enough to gate against that
  // on their own. The ref is set/cleared synchronously inside loadMore.
  const recentLoadingLatch = useRef(false);

  const openPreview = useCallback((p: ImagePreview) => setPreview(p), []);
  const closePreview = useCallback(() => setPreview(null), []);

  const loadEnrolled = useCallback(async () => {
    try {
      setEnrolledLoading(true);
      const body = await fetchJson<{ faces: EnrolledFace[] }>("/api/faces", { cache: "no-store" });
      setEnrolled(body.faces);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load enrolled faces.");
    } finally {
      setEnrolledLoading(false);
    }
  }, []);

  const loadInitialRecent = useCallback(async () => {
    if (recentLoadingLatch.current) return;
    recentLoadingLatch.current = true;
    setRecentLoading(true);
    try {
      const res = await fetch(
        `/api/face-matches/recent?limit=${RECENT_PAGE_SIZE}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { rows: MatchRow[] };
      setRecent(body.rows);
      setRecentHasMore(body.rows.length === RECENT_PAGE_SIZE);
    } catch {
      // non-fatal; the SSE stream picks up new matches as they happen.
    } finally {
      recentLoadingLatch.current = false;
      setRecentLoading(false);
    }
  }, []);

  const loadMoreRecent = useCallback(async () => {
    if (recentLoadingLatch.current || !recentHasMore || recent.length === 0) return;
    const tail = recent[recent.length - 1];
    recentLoadingLatch.current = true;
    setRecentLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(RECENT_PAGE_SIZE),
        before_ts: tail.ts,
        before_id: String(tail.id),
      });
      const res = await fetch(`/api/face-matches/recent?${params}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { rows: MatchRow[] };
      // Dedupe against the existing list - a row inserted via SSE between
      // pages could otherwise appear twice (once at the top from SSE,
      // once in the older page from the server).
      setRecent((current) => {
        const seen = new Set(current.map((r) => r.id));
        const fresh = body.rows.filter((r) => !seen.has(r.id));
        return [...current, ...fresh];
      });
      setRecentHasMore(body.rows.length === RECENT_PAGE_SIZE);
    } catch {
      // non-fatal; the user can try again by scrolling back to the sentinel.
    } finally {
      recentLoadingLatch.current = false;
      setRecentLoading(false);
    }
  }, [recent, recentHasMore]);

  useEffect(() => {
    if (!isActive) return;
    void loadEnrolled();
  }, [isActive, loadEnrolled]);

  // Recent matches load eagerly on mount, independent of `isActive`,
  // so the panel is populated even if the webcam never starts or the
  // user hasn't enrolled anyone yet. The SSE stream below handles
  // live updates when the page is the active route.
  useEffect(() => {
    void loadInitialRecent();
  }, [loadInitialRecent]);

  // Live tail of new match events. The SSE stream pushes any face_matches
  // row inserted server-side; we prepend so the most recent shows up at
  // the top of the recent list (and the toast fires on banned matches).
  // We deliberately don't cap the list here: the infinite-scroll pager
  // below may have loaded older rows, and trimming would discard them.
  useEffect(() => {
    if (!isActive) return;
    const es = new EventSource("/api/face-matches/stream");
    es.addEventListener("match", (ev) => {
      try {
        const row = JSON.parse((ev as MessageEvent).data) as MatchRow;
        setRecent((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
        if (row.role === "banned") {
          toast.error(`Banned subject detected: ${row.name}`, { id: `banned-${row.face_id}` });
        }
      } catch {
        // ignore malformed events
      }
    });
    return () => es.close();
  }, [isActive]);

  const handleFaceDeleted = useCallback((id: number) => {
    setEnrolled((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleFaceEnrolled = useCallback(() => {
    void loadEnrolled();
  }, [loadEnrolled]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <EnrollFaceCard onEnrolled={handleFaceEnrolled} />
          <EnrolledFacesCard
            faces={enrolled}
            loading={enrolledLoading}
            onDeleted={handleFaceDeleted}
            onPreview={openPreview}
          />
        </div>

        <div className="lg:col-span-2 space-y-6">
          <FaceMatchFeed isActive={isActive} enrolled={enrolled} />
          <RecentMatchesCard
            rows={recent}
            loading={recentLoading}
            hasMore={recentHasMore}
            onLoadMore={loadMoreRecent}
            onPreview={openPreview}
          />
        </div>
      </div>

      <ImageModal
        open={preview !== null}
        onOpenChange={(open) => { if (!open) closePreview(); }}
        src={preview?.src ?? null}
        alt={preview?.alt ?? ""}
        mirror={preview?.mirror}
        caption={preview?.caption}
      />
    </>
  );
}

// ─── Enroll card ─────────────────────────────────────────────────────────

interface EnrollFaceCardProps {
  onEnrolled: () => void;
}

function EnrollFaceCard({ onEnrolled }: EnrollFaceCardProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("banned");
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file.");
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      toast.error("Image is larger than 6MB; pick a smaller photo.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setImageData(reader.result);
        setImageName(file.name);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const reset = useCallback(() => {
    setName("");
    setRole("banned");
    setImageData(null);
    setImageName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleEnroll = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Add a name for the enrolled face.");
      return;
    }
    if (!imageData) {
      toast.error("Add a photo of the face to enroll.");
      return;
    }
    setBusy(true);
    try {
      // The server caps the thumbnail it persists at ~750KB; raw photos
      // from a file picker are routinely 3-7MB, so they'd land as NULL
      // and the enrolled-list would show no preview. Downscale to a
      // reasonable selfie thumbnail first - InsightFace embeds the
      // largest face just fine at 480px and the JPEG comes in well
      // under the cap with plenty of margin.
      const resized = (await resizeDataUrl(imageData, { maxDimension: 480, quality: 0.85 })) ?? imageData;
      await fetchJson("/api/faces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, role, image: resized }),
      });
      toast.success(`Enrolled ${trimmed} (${ROLE_META[role].label}).`);
      reset();
      onEnrolled();
    } catch (err) {
      // EndpointNotDeployedError carries a friendly message with the
      // exact `databricks bundle run ...` so the toast already reads
      // well; no special-casing needed here. The live-match panel
      // shows the persistent banner.
      toast.error(err instanceof Error ? err.message : "Enrollment failed.");
    } finally {
      setBusy(false);
    }
  }, [name, role, imageData, onEnrolled, reset]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <UserPlus className="w-4 h-4" />
          Enroll a face
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="face-name">Name</Label>
          <Input
            id="face-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="J. Doe"
            disabled={busy}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="face-role">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="face-role"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(ROLE_META) as Role[]).map((r) => (
                <SelectItem key={r} value={r}>{ROLE_META[r].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="face-image">Photo</Label>
          <Input
            id="face-image"
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            disabled={busy}
          />
          {imageData && (
            <div className="mt-2 relative inline-block">
              <img
                src={imageData}
                alt={imageName ?? "preview"}
                className="max-h-40 rounded-md border border-slate-200"
              />
              <button
                type="button"
                onClick={() => {
                  setImageData(null);
                  setImageName(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                aria-label="Remove image"
                className="absolute -top-2 -right-2 bg-white rounded-full border border-slate-200 p-0.5 hover:bg-slate-100"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
        <Button onClick={handleEnroll} disabled={busy} className="w-full gap-2">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          {busy ? "Enrolling..." : "Enroll face"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Enrolled list ───────────────────────────────────────────────────────

interface EnrolledFacesCardProps {
  faces: EnrolledFace[];
  loading: boolean;
  onDeleted: (id: number) => void;
  onPreview: (preview: ImagePreview) => void;
}

function EnrolledFacesCard({ faces, loading, onDeleted, onPreview }: EnrolledFacesCardProps) {
  const handleDelete = useCallback(
    async (id: number, name: string) => {
      if (!confirm(`Remove ${name} from the enrolled faces?`)) return;
      try {
        await fetchJson(`/api/faces/${id}`, { method: "DELETE" });
        toast.success(`Removed ${name}.`);
        onDeleted(id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    },
    [onDeleted],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Enrolled faces</CardTitle>
        <CardDescription>
          {faces.length} face{faces.length === 1 ? "" : "s"} on file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && faces.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-sm text-slate-500">
            <Spinner className="w-4 h-4 mr-2" />
            Loading...
          </div>
        ) : faces.length === 0 ? (
          <div className="text-sm text-slate-500">
            No faces enrolled yet. Add one above to start matching.
          </div>
        ) : (
          <div className="space-y-2 max-h-[460px] overflow-y-auto">
            {faces.map((f) => {
              const meta = ROLE_META[f.role];
              const Icon = meta.icon;
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md bg-slate-50"
                >
                  {f.image ? (
                    <button
                      type="button"
                      onClick={() => onPreview({
                        src: f.image!,
                        alt: f.name,
                        caption: `${f.name} · ${meta.label}`,
                      })}
                      aria-label={`Preview photo of ${f.name}`}
                      className="shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-slate-300"
                    >
                      <img
                        src={f.image}
                        alt={f.name}
                        className="w-10 h-10 rounded-full object-cover border border-slate-200 hover:opacity-80 transition-opacity cursor-zoom-in"
                      />
                    </button>
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-slate-200 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-slate-900 truncate">{f.name}</div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Icon className="w-3 h-3" style={{ color: meta.color }} />
                      <span>{meta.label}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => void handleDelete(f.id, f.name)}
                    aria-label={`Remove ${f.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Webcam feed + bbox overlay ──────────────────────────────────────────

interface FaceMatchFeedProps {
  isActive: boolean;
  enrolled: EnrolledFace[];
}

function FaceMatchFeed({ isActive, enrolled }: FaceMatchFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Camera lifecycle + intrinsic video size. The "user" facingMode picks
  // the front-facing camera on mobile / laptop lid, which is the right
  // default for face capture; we mirror the preview so users see a
  // natural selfie view.
  const { videoSize, status: cameraStatus } = useWebcamStream(videoRef, {
    isActive,
    facingMode: "user",
  });

  const [faces, setFaces] = useState<FaceFromTick[]>([]);
  // Smoothed per-tick latency. We could surface the raw number but it
  // jitters by ~30ms every 666ms and reads like a buggy spinner; an EMA
  // updated every few ticks settles to a value the user can read.
  const [avgTickMs, setAvgTickMs] = useState<number | null>(null);
  const avgTickRef = useRef<{ value: number; count: number } | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);
  // The face_recognition endpoint isn't deployed yet (or scaled to zero
  // and was deleted). Pause the tick loop so we stop spamming /api/face-
  // match every 666ms with a request that will never succeed until the
  // operator runs the deploy. `missingInfo` carries the structured
  // payload from the server so the banner can render the right
  // `databricks bundle run <job>` without hardcoding it.
  const [missingInfo, setMissingInfo] = useState<EndpointNotDeployedError | null>(null);
  const endpointMissing = missingInfo !== null;

  // The tick body. Pulled out as a stable callback so useDetectionLoop's
  // ref update path is cheap. We never block on the response - the loop's
  // own in-flight guard handles backpressure.
  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video || cameraStatus.kind !== "ready") return;
    const frame = captureVideoFrameForDetection(video, { maxDimension: 640, quality: 0.72 });
    if (!frame) return;
    const start = Date.now();
    try {
      const body = await fetchJson<{ faces: FaceFromTick[] }>("/api/face-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: frame.image, source_id: "webcam" }),
      });
      // Scale bboxes from the downscaled detect frame back to the source
      // video resolution so the canvas overlay lands on the right pixels.
      const scaled: FaceFromTick[] = body.faces.map((f) => ({
        ...f,
        bbox: [
          Math.round(f.bbox[0] * frame.scaleX),
          Math.round(f.bbox[1] * frame.scaleY),
          Math.round(f.bbox[2] * frame.scaleX),
          Math.round(f.bbox[3] * frame.scaleY),
        ],
      }));
      setFaces(scaled);
      setTickError(null);

      // Update the EMA on every tick, but only push it to React state
      // every ~5 ticks so the status footer doesn't twitch every 666ms.
      const elapsed = Date.now() - start;
      const prev = avgTickRef.current;
      const next = prev
        ? { value: prev.value * 0.7 + elapsed * 0.3, count: prev.count + 1 }
        : { value: elapsed, count: 1 };
      avgTickRef.current = next;
      if (next.count === 1 || next.count % 5 === 0) {
        setAvgTickMs(Math.round(next.value));
      }
    } catch (err) {
      if (err instanceof EndpointNotDeployedError) {
        setMissingInfo(err);
        setTickError(err.message);
        return;
      }
      setTickError(err instanceof Error ? err.message : String(err));
    }
  }, [cameraStatus.kind]);

  useDetectionLoop({
    isActive: isActive && cameraStatus.kind === "ready" && !endpointMissing,
    intervalMs: TICK_INTERVAL_MS,
    cooldownMs: TICK_COOLDOWN_MS,
    tick,
  });

  const handleRetryEndpoint = useCallback(() => {
    setTickError(null);
    setMissingInfo(null);
  }, []);

  // When enrolled set changes we want stale matches to update label /
  // colour. Easiest is to drop them - the next tick re-fills.
  useEffect(() => {
    setFaces([]);
  }, [enrolled.length]);

  // Translate face-match results into the shared overlay format.
  const overlayBoxes: OverlayBox[] = useMemo(
    () =>
      faces.map((f) => {
        if (f.match) {
          const meta = ROLE_META[f.match.role] ?? ROLE_META.staff;
          return {
            bbox: f.bbox,
            color: meta.color,
            label: `${f.match.name}  ${(f.match.similarity * 100).toFixed(0)}%`,
          };
        }
        return {
          bbox: f.bbox,
          color: UNKNOWN_COLOR,
          label: "Unknown",
        };
      }),
    [faces],
  );

  // Redraw the canvas whenever the boxes or video size changes. The
  // selfie video is CSS-mirrored, so we pass `mirrorX: true` here and
  // intentionally do *not* mirror the canvas itself - that keeps the
  // bbox label text readable while still aligning with the mirrored
  // preview.
  useEffect(() => {
    drawBboxOverlay(canvasRef.current, videoRef.current, videoSize, overlayBoxes, {
      mirrorX: true,
    });
  }, [overlayBoxes, videoSize]);

  const matchedCount = faces.filter((f) => f.match).length;
  const enrolledLabel = enrolled.length === 0
    ? "No enrolled faces yet"
    : `${enrolled.length} enrolled face${enrolled.length === 1 ? "" : "s"}`;

  // Hold the "N faces" / "N matches" badge label across short empty
  // ticks so it doesn't strobe between "Watching..." and a count every
  // 666ms whenever the detector misses a frame.
  const stableLabel = useStableFaceBadge(faces.length, matchedCount);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Live face match</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="relative bg-black rounded-lg overflow-hidden"
          style={{
            aspectRatio: videoSize.w > 0 && videoSize.h > 0
              ? `${videoSize.w} / ${videoSize.h}`
              : "16 / 9",
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            // Mirror the video preview so the user gets a natural selfie
            // view. The canvas overlay is *not* CSS-mirrored - instead
            // `drawBboxOverlay({ mirrorX: true })` flips bbox x-coords
            // for us. That keeps label text readable (a CSS mirror
            // would invert "John 92%" into "%29 nhoJ") while still
            // aligning boxes with the mirrored video.
            style={{ transform: "scaleX(-1)" }}
            className="absolute inset-0 w-full h-full object-contain"
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />
          {cameraStatus.kind === "ready" ? (
            <Badge
              variant="outline"
              className="absolute top-2 left-2 gap-1.5 backdrop-blur bg-white/85"
            >
              {stableLabel.kind === "matched"
                ? <span className="text-emerald-700">{stableLabel.count} match{stableLabel.count === 1 ? "" : "es"}</span>
                : stableLabel.kind === "unknown"
                ? <span className="text-slate-700">{stableLabel.count} unknown face{stableLabel.count === 1 ? "" : "s"}</span>
                : <span className="text-slate-500">Watching for faces...</span>}
            </Badge>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm px-6 text-center">
              {cameraStatus.message || "Starting camera..."}
            </div>
          )}
        </div>

        {missingInfo && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-2">
            <div className="font-medium">{missingInfo.displayName} endpoint is not deployed.</div>
            {missingInfo.deployJob && (
              <div>
                Run{" "}
                <code className="font-mono bg-amber-100 px-1 rounded">
                  databricks bundle run {missingInfo.deployJob}
                </code>{" "}
                to provision it. Cold start is ~10 minutes.
              </div>
            )}
            <Button size="sm" variant="outline" onClick={handleRetryEndpoint} className="h-7">
              Try again
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>{enrolledLabel}</span>
          <span className="tabular-nums">
            {tickError && !endpointMissing
              ? <span className="text-red-600">{tickError}</span>
              : endpointMissing
              ? <span className="text-amber-700">paused: endpoint missing</span>
              : avgTickMs != null
              ? `avg match: ${avgTickMs}ms`
              : "warming up"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Recent matches ──────────────────────────────────────────────────────

interface RecentMatchesCardProps {
  rows: MatchRow[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onPreview: (preview: ImagePreview) => void;
}

function RecentMatchesCard({
  rows, loading, hasMore, onLoadMore, onPreview,
}: RecentMatchesCardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Keep the latest onLoadMore in a ref so the IntersectionObserver doesn't
  // need to rebind every time the callback's identity changes (it changes
  // whenever `recent` does, which is every SSE push).
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => { onLoadMoreRef.current = onLoadMore; }, [onLoadMore]);

  useEffect(() => {
    if (!hasMore) return;
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
      },
      // rootMargin pre-fetches the next page before the sentinel hits
      // the actual viewport, so scrolling stays smooth instead of
      // bumping into a spinner at the bottom.
      { root, rootMargin: "300px", threshold: 0 },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [hasMore]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent matches</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-sm text-slate-500">
            <Spinner className="w-4 h-4 mr-2" />
            Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-slate-500">
            No matches recorded yet. Enroll a face above and step in front of the camera.
          </div>
        ) : (
          <div ref={scrollRef} className="space-y-2 max-h-[460px] overflow-y-auto">
            {rows.map((row) => (
              <RecentMatchRow key={row.id} row={row} onPreview={onPreview} />
            ))}
            {hasMore ? (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center py-3 text-xs text-slate-400"
              >
                {loading ? (
                  <>
                    <Spinner className="w-3 h-3 mr-1.5" />
                    Loading more...
                  </>
                ) : null}
              </div>
            ) : (
              <div className="py-3 text-center text-xs text-slate-400">
                End of matches
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface RecentMatchRowProps {
  row: MatchRow;
  onPreview: (preview: ImagePreview) => void;
}

function RecentMatchRow({ row, onPreview }: RecentMatchRowProps) {
  const meta = ROLE_META[row.role] ?? ROLE_META.staff;
  const Icon = meta.icon;
  // Banned subjects get a red wash so they pop in a long scroll;
  // VIP / staff stay on the neutral slate background.
  const background = row.role === "banned"
    ? "rgba(220, 38, 38, 0.08)"
    : "rgb(248 250 252)";

  const sharedCaption = `${row.name} · ${meta.label} · ${(row.similarity * 100).toFixed(0)}% match · ${_formatRelative(row.ts)}`;

  return (
    <div
      className="flex items-stretch gap-3 px-3 py-2 rounded-md"
      style={{ backgroundColor: background }}
    >
      <MatchThumbnail
        src={row.frame_image}
        alt={`Live frame at ${row.ts}`}
        caption="Live"
        fallbackIcon={Icon}
        fallbackColor={meta.color}
        // The live frame is the unmirrored source the detector ran on;
        // for a selfie-style cam that reads "backwards" to the operator,
        // so we mirror the preview thumbnail to match what they saw on
        // screen when the match fired.
        mirror
        onClick={row.frame_image ? () => onPreview({
          src: row.frame_image!,
          alt: `Live frame: ${row.name}`,
          caption: `Live capture · ${sharedCaption}`,
          mirror: true,
        }) : undefined}
      />
      <MatchThumbnail
        src={row.enrolled_image}
        alt={`${row.name} (enrolled reference)`}
        caption="Enrolled"
        fallbackIcon={Icon}
        fallbackColor={meta.color}
        onClick={row.enrolled_image ? () => onPreview({
          src: row.enrolled_image!,
          alt: `Enrolled reference: ${row.name}`,
          caption: `Enrolled reference · ${sharedCaption}`,
        }) : undefined}
      />
      <div className="min-w-0 flex-1 self-center">
        <div className="font-medium text-sm text-slate-900 truncate">{row.name}</div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Icon className="w-3 h-3" style={{ color: meta.color }} />
          <span>{meta.label}</span>
          <span>·</span>
          <span>{(row.similarity * 100).toFixed(0)}% match</span>
        </div>
      </div>
      <span className="text-xs text-slate-500 tabular-nums shrink-0 self-center">
        {_formatRelative(row.ts)}
      </span>
    </div>
  );
}

interface MatchThumbnailProps {
  src: string | null;
  alt: string;
  caption: string;
  fallbackIcon: typeof ShieldAlert;
  fallbackColor: string;
  mirror?: boolean;
  onClick?: () => void;
}

function MatchThumbnail({
  src, alt, caption, fallbackIcon: Icon, fallbackColor, mirror = false, onClick,
}: MatchThumbnailProps) {
  const imageNode = src ? (
    <img
      src={src}
      alt={alt}
      className="w-12 h-12 rounded-md object-cover border border-slate-200"
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  ) : (
    <div className="w-12 h-12 rounded-md bg-slate-200 border border-slate-200 flex items-center justify-center">
      <Icon className="w-4 h-4" style={{ color: fallbackColor }} />
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={`Preview ${alt}`}
          className="rounded-md focus:outline-none focus:ring-2 focus:ring-slate-300 hover:opacity-80 transition-opacity cursor-zoom-in"
        >
          {imageNode}
        </button>
      ) : imageNode}
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{caption}</span>
    </div>
  );
}

// Hold the badge content across short "no faces" gaps so the pill in the
// top-left of the live feed doesn't flip back to "Watching..." every
// time the detector misses a single frame (a head turn, eyes closed,
// motion blur etc.). We keep the last positive state for STABLE_HOLD_MS;
// once that elapses with empty ticks we transition back to "watching".
const STABLE_HOLD_MS = 2_500;

type StableFaceBadgeState =
  | { kind: "matched"; count: number }
  | { kind: "unknown"; count: number }
  | { kind: "idle" };

function useStableFaceBadge(faceCount: number, matchedCount: number): StableFaceBadgeState {
  const [state, setState] = useState<StableFaceBadgeState>({ kind: "idle" });
  const lastPositiveRef = useRef<number>(0);

  useEffect(() => {
    if (matchedCount > 0) {
      lastPositiveRef.current = Date.now();
      setState({ kind: "matched", count: matchedCount });
      return;
    }
    if (faceCount > 0) {
      lastPositiveRef.current = Date.now();
      setState({ kind: "unknown", count: faceCount });
      return;
    }
    // Empty tick: keep the previous label until the hold window passes.
    const elapsed = Date.now() - lastPositiveRef.current;
    if (elapsed >= STABLE_HOLD_MS) {
      setState({ kind: "idle" });
      return;
    }
    const remaining = STABLE_HOLD_MS - elapsed;
    const id = setTimeout(() => {
      if (Date.now() - lastPositiveRef.current >= STABLE_HOLD_MS) {
        setState({ kind: "idle" });
      }
    }, remaining + 50);
    return () => clearTimeout(id);
  }, [faceCount, matchedCount]);

  return state;
}

function _formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

// captureVideoFrame is re-exported so a future "save a clearer reference
// photo from the webcam" button can pull a high-res grab without going
// through the resize path. Currently unused on the page but kept imported
// to avoid lint nags during the next iteration.
export { captureVideoFrame };
