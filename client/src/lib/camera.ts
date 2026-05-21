// Browser camera helpers used by the Live and Upload pages. Kept framework
// free so they can be tested in isolation.

const VIDEO_WIDTH_IDEAL = 1280;
const VIDEO_HEIGHT_IDEAL = 720;

/** Max longest edge (px) sent to /api/detect on the live tick. 640 matches the
 * native input size for YOLOv8/v11 + the Roboflow PyFunc, so we don't lose
 * accuracy by going lower, and the resulting JPEG stays under ~120KB. */
export const DETECT_MAX_DIMENSION = 640;

/** Max longest edge (px) for persisted snapshots (Save snapshot / Upload).
 * Larger than the live tick because the frame also lands in the UC volume and
 * we want a usable still, but capped so even a busy 1080p source stays under
 * ~700KB JPEG (~950KB base64) - well below the server bodyLimit. */
export const SNAPSHOT_MAX_DIMENSION = 800;

export interface DetectionFrame {
  image: string;
  /** Multiply detector bbox coords by this to map onto full video/canvas pixels. */
  scaleX: number;
  scaleY: number;
}

export async function requestCameraStream(
  facingMode: "environment" | "user" = "environment",
): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: VIDEO_WIDTH_IDEAL, max: VIDEO_WIDTH_IDEAL },
        height: { ideal: VIDEO_HEIGHT_IDEAL, max: VIDEO_HEIGHT_IDEAL },
      },
    });
  } catch (err) {
    console.error("Camera access error:", err);
    return null;
  }
}

export function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => {
    if (t.readyState !== "ended") t.stop();
  });
}

function _fitWithinBox(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function _drawToDataUrl(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  quality: number,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, outW, outH);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Full-resolution JPEG data URL (e.g. persist to UC volume). */
export function captureVideoFrame(video: HTMLVideoElement, quality = 0.7): string | null {
  if (video.readyState !== video.HAVE_ENOUGH_DATA) return null;
  const w = video.videoWidth || 0;
  const h = video.videoHeight || 0;
  if (w <= 0 || h <= 0) return null;
  return _drawToDataUrl(video, w, h, w, h, quality);
}

/**
 * Downscale a frame before POST /api/detect, then scale bounding boxes back up
 * with `scaleX` / `scaleY` on the client.
 */
export function captureVideoFrameForDetection(
  video: HTMLVideoElement,
  options: { maxDimension?: number; quality?: number } = {},
): DetectionFrame | null {
  if (video.readyState !== video.HAVE_ENOUGH_DATA) return null;
  const w = video.videoWidth || 0;
  const h = video.videoHeight || 0;
  if (w <= 0 || h <= 0) return null;

  const maxDimension = options.maxDimension ?? DETECT_MAX_DIMENSION;
  const quality = options.quality ?? 0.62;
  const { width: detectW, height: detectH } = _fitWithinBox(w, h, maxDimension);
  const image = _drawToDataUrl(video, w, h, detectW, detectH, quality);
  if (!image) return null;

  return {
    image,
    scaleX: w / detectW,
    scaleY: h / detectH,
  };
}

/** Resize any image data URL for detection; returns scale factors vs source pixels. */
export function resizeDataUrlForDetection(
  dataUrl: string,
  sourceWidth: number,
  sourceHeight: number,
  options: { maxDimension?: number; quality?: number } = {},
): Promise<DetectionFrame | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = sourceWidth > 0 ? sourceWidth : img.naturalWidth;
      const h = sourceHeight > 0 ? sourceHeight : img.naturalHeight;
      if (w <= 0 || h <= 0) {
        resolve(null);
        return;
      }
      const maxDimension = options.maxDimension ?? DETECT_MAX_DIMENSION;
      const quality = options.quality ?? 0.62;
      const { width: detectW, height: detectH } = _fitWithinBox(w, h, maxDimension);
      const image = _drawToDataUrl(img, w, h, detectW, detectH, quality);
      if (!image) {
        resolve(null);
        return;
      }
      resolve({
        image,
        scaleX: w / detectW,
        scaleY: h / detectH,
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export function scaleDetectionBbox(
  bbox: [number, number, number, number],
  scaleX: number,
  scaleY: number,
): [number, number, number, number] {
  return [
    Math.round(bbox[0] * scaleX),
    Math.round(bbox[1] * scaleY),
    Math.round(bbox[2] * scaleX),
    Math.round(bbox[3] * scaleY),
  ];
}
