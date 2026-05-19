// Browser camera helpers used by the Live and Upload pages. Kept framework
// free so they can be tested in isolation.

const VIDEO_WIDTH_IDEAL = 1280;
const VIDEO_HEIGHT_IDEAL = 720;

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

export function captureVideoFrame(video: HTMLVideoElement, quality = 0.7): string | null {
  if (video.readyState !== video.HAVE_ENOUGH_DATA) return null;
  const w = video.videoWidth || 0;
  const h = video.videoHeight || 0;
  if (w <= 0 || h <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}
