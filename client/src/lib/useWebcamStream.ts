// Camera lifecycle hook: requests a MediaStream from the device, attaches it
// to the supplied <video> element, tracks the video's intrinsic resolution
// (for bbox overlay sizing), and tears everything down when the hook
// deactivates or unmounts.
//
// Previously duplicated in Live.tsx and would have been duplicated again in
// FaceRecognition.tsx; the hook centralizes the rules (mute/autoplay setup,
// secure-context detection, denied/no-camera/error branching, cleanup on
// route change).
import { useEffect, useState, type RefObject } from "react";
import {
  requestCameraStream,
  stopMediaStream,
  type CameraStreamResult,
} from "./camera";

export type WebcamStatusKind = "idle" | "loading" | "ready" | "denied" | "missing" | "insecure" | "error";

export interface WebcamStatus {
  kind: WebcamStatusKind;
  message: string;
}

export interface UseWebcamStreamOptions {
  /** When false the hook releases the stream and stays idle (saves CPU + light when the tab is hidden or the page is not visible). */
  isActive: boolean;
  /** "user" for selfie / face capture, "environment" for the rear camera on mobile. */
  facingMode?: "environment" | "user";
}

export interface UseWebcamStreamResult {
  videoSize: { w: number; h: number };
  status: WebcamStatus;
}

function _statusFromResult(result: CameraStreamResult): WebcamStatus {
  switch (result.reason) {
    case "denied":
      return { kind: "denied", message: result.message };
    case "no-camera":
      return { kind: "missing", message: result.message };
    case "insecure-context":
      return { kind: "insecure", message: result.message };
    case "error":
      return { kind: "error", message: result.message };
    default:
      return { kind: "idle", message: "" };
  }
}

export function useWebcamStream(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: UseWebcamStreamOptions,
): UseWebcamStreamResult {
  const { isActive, facingMode = "environment" } = options;
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [status, setStatus] = useState<WebcamStatus>({ kind: "idle", message: "" });

  useEffect(() => {
    if (!isActive) {
      setStatus({ kind: "idle", message: "" });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    setStatus({ kind: "loading", message: "Requesting camera..." });

    const attach = async () => {
      const result = await requestCameraStream(facingMode);
      if (cancelled) {
        stopMediaStream(result.stream);
        return;
      }
      if (!result.stream) {
        setStatus(_statusFromResult(result));
        return;
      }
      video.srcObject = result.stream;
      video.removeAttribute("src");
      video.loop = false;
      video.muted = true;
      const track = result.stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      const w = settings?.width ?? 0;
      const h = settings?.height ?? 0;
      setStatus({ kind: "ready", message: `Camera ready (${w || "?"}x${h || "?"})` });
      await video.play().catch(() => undefined);
    };

    const syncVideoSize = () => {
      setVideoSize({ w: video.videoWidth || 0, h: video.videoHeight || 0 });
    };
    video.addEventListener("loadedmetadata", syncVideoSize);
    video.addEventListener("resize", syncVideoSize);

    void attach();

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", syncVideoSize);
      video.removeEventListener("resize", syncVideoSize);
      stopMediaStream((video.srcObject as MediaStream | null) ?? null);
      video.srcObject = null;
      video.load();
    };
  }, [isActive, facingMode, videoRef]);

  return { videoSize, status };
}
