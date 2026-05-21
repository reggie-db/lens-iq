// Helper for calling the backend /api/detect route. The route forwards the
// request to the YOLO detector serving endpoint deployed by
// notebooks/deploy_yolo.ipynb.

export interface Detection {
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface DetectorResult {
  detections: Detection[];
  /**
   * Present when the request was made with `persist: true` and the frame was
   * successfully stored in the UC `frames` volume. `url` points at the Files
   * plugin's raw endpoint so the image can be rendered inline.
   */
  saved: { frame_id: string; url: string } | null;
}

export interface CallDetectorOptions {
  conf?: number;
  iou?: number;
  /**
   * If true, the server uploads the frame to the `frames` UC volume and
   * inserts one row per detection into the `detections` table. The Detections
   * page picks them up via /api/detections/stream within ~2s.
   */
  persist?: boolean;
  /**
   * Model id from the MODELS registry. Defaults server-side to `yolo`.
   * See `lib/models.ts` for the full list.
   */
  model?: string;
}

export async function callDetector(
  image: string,
  options: CallDetectorOptions = {},
): Promise<DetectorResult> {
  const { conf = 0.35, iou = 0.5, persist = false, model } = options;
  const res = await fetch("/api/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, conf, iou, persist, model }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || `Detector failed (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch {
      if (res.status === 413 || /payload too large/i.test(text)) {
        message = "Image payload too large. The Live page downscales frames automatically; retry or lower FPS.";
      } else if (text.trimStart().startsWith("<")) {
        message = `Detector failed (HTTP ${res.status}). The server returned an HTML error page instead of JSON.`;
      }
    }
    throw new Error(message);
  }
  const body = await res.json();
  const items: unknown[] = Array.isArray(body?.detections) ? body.detections : [];
  const detections: Detection[] = items
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
    .map((d) => ({
      label: typeof d.label === "string" ? d.label : "object",
      confidence: typeof d.confidence === "number" ? d.confidence : 0,
      bbox: Array.isArray(d.bbox) && d.bbox.length === 4
        ? (d.bbox as [number, number, number, number])
        : [0, 0, 0, 0],
    }));
  return {
    detections,
    saved: body?.saved && typeof body.saved.frame_id === "string"
      ? { frame_id: body.saved.frame_id, url: String(body.saved.url) }
      : null,
  };
}
