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
  /**
   * High-uniqueness frame fingerprint used as the server-side Claude-vision
   * cache key. This is a SHA-256 over normalized DECODED RGBA pixels (the
   * frame redrawn to a fixed-max-dimension canvas), not the JPEG bytes. The
   * same visual frame hashes the same even when the data URL / JPEG encoding
   * differs - so a looping clip's replays still hit cache - while a minute
   * visual change produces a new key, so distinct frames never reuse a
   * neighbour's boxes. The server does an EXACT key lookup on this (no fuzzy
   * matching). Null only if the canvas can't be read (e.g. a tainted source),
   * in which case the server falls back to a raw byte hash.
   */
  fingerprint: string | null;
}

// Max canvas dimension the frame is normalized to before hashing. Downscaling
// to a fixed box makes the hash independent of the source resolution and
// strips the high-frequency detail that JPEG re-encoding jitters, so a looping
// clip's replays of one scene hash identically. Small enough to keep the
// per-frame getImageData + SHA-256 cheap, large enough that genuinely
// different frames still differ in the decoded pixels.
const _FINGERPRINT_MAX_DIMENSION = 320;

// SHA-256 over normalized DECODED RGBA pixels of `source`, returned as a
// 64-char hex string. Unlike a JPEG-byte hash (which changes every time the
// browser re-encodes the same frame) this hashes the post-decode pixels after
// redrawing to a fixed-max-dimension canvas, so the same visual frame is
// stable across encodings while any real visual change yields a new key. The
// server uses it for an exact-match cache lookup. Returns null if the 2D
// context can't be created or the pixels are unreadable (tainted canvas).
async function _frameFingerprint(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxDimension = _FINGERPRINT_MAX_DIMENSION,
): Promise<string | null> {
  const { width, height } = _fitWithinBox(srcW, srcH, maxDimension);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, width, height);
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
  // Copy into a plain ArrayBuffer-backed view: getImageData returns a
  // Uint8ClampedArray whose buffer type is widened to ArrayBufferLike (could
  // be SharedArrayBuffer), which crypto.subtle.digest's BufferSource rejects.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(pixels));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CameraStreamResult {
  stream: MediaStream | null;
  /** Why the stream is null. `null` when stream is not null. */
  reason: "ok" | "insecure-context" | "denied" | "no-camera" | "error";
  message: string;
}

// `navigator.mediaDevices` is only exposed on secure contexts: HTTPS pages
// and same-origin loopback (`localhost`, `127.0.0.1`, `::1`). Loading the
// dev server over a LAN IP (`http://192.168.x.x:8001`) or any other plain
// HTTP host leaves `mediaDevices` undefined, and a naive `getUserMedia`
// call throws `TypeError: Cannot read properties of undefined`. Detect
// that up front so we can show a useful "use HTTPS or localhost" message
// instead of a misleading "Camera access denied".
function _isSecureCameraContext(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export async function requestCameraStream(
  facingMode: "environment" | "user" = "environment",
): Promise<CameraStreamResult> {
  if (!_isSecureCameraContext()) {
    const host = typeof window !== "undefined" ? window.location.host : "?";
    return {
      stream: null,
      reason: "insecure-context",
      message: `Camera unavailable on http://${host}. Open the app via http://localhost or HTTPS to use the webcam.`,
    };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: VIDEO_WIDTH_IDEAL, max: VIDEO_WIDTH_IDEAL },
        height: { ideal: VIDEO_HEIGHT_IDEAL, max: VIDEO_HEIGHT_IDEAL },
      },
    });
    return { stream, reason: "ok", message: "" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        stream: null,
        reason: "denied",
        message: "Camera access denied. Allow camera permission in your browser to use the webcam.",
      };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return {
        stream: null,
        reason: "no-camera",
        message: "No camera found. Pick a sample video instead, or attach a webcam.",
      };
    }
    console.error("Camera access error:", err);
    return {
      stream: null,
      reason: "error",
      message: err instanceof Error ? err.message : "Unable to start the camera.",
    };
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
export async function captureVideoFrameForDetection(
  video: HTMLVideoElement,
  options: { maxDimension?: number; quality?: number } = {},
): Promise<DetectionFrame | null> {
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
    fingerprint: await _frameFingerprint(video, w, h),
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
    img.onload = async () => {
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
        fingerprint: await _frameFingerprint(img, w, h),
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Generic data-URL resizer. Use for upload thumbnails / enrollment photos
 * where the source comes from a file picker and is usually multi-MB.
 * Returns the resized JPEG data URL, or the original when already under
 * the cap. Use `resizeDataUrlForDetection` instead when you need bbox
 * scale factors.
 */
export function resizeDataUrl(
  dataUrl: string,
  options: { maxDimension?: number; quality?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w <= 0 || h <= 0) {
        resolve(null);
        return;
      }
      const maxDimension = options.maxDimension ?? SNAPSHOT_MAX_DIMENSION;
      const quality = options.quality ?? 0.82;
      const { width: outW, height: outH } = _fitWithinBox(w, h, maxDimension);
      resolve(_drawToDataUrl(img, w, h, outW, outH, quality));
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
