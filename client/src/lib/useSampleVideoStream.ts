// Sample-video lifecycle hook. Mirrors useWebcamStream but for the proxied
// /api/sample-videos/:id MP4 sources used by Live / Spills / Plates /
// Guests / CameraHealth.
//
// What it owns:
//   - Setting `video.src` from the picked SampleVideo, with crossOrigin so
//     canvas captures don't taint and the detection loop keeps working.
//   - Calling video.play() and clearing the "loading" status as soon as
//     the first frame is actually being played back (the `playing` event,
//     not just `loadedmetadata` which fires before any pixel is decoded).
//   - Tracking intrinsic video size for bbox overlay sizing.
//   - Translating `error` events into a human-readable message via
//     describeClipFailure(), so a 404 on the proxied URL shows the actual
//     server-side cause instead of "Loading clip..." forever.
//   - Releasing the src on cleanup so the next sample (or webcam) can
//     take over the same <video> element.
//
// What it deliberately does NOT own:
//   - timeupdate / loop-wraparound detection (Spills uses this to reset
//     its spill-to-cone cycle). Pages that need it add their own listener
//     in a separate useEffect.
//   - Detection ticking (use useDetectionLoop).
import { useEffect, useState, type RefObject } from "react";
import { describeClipFailure, sampleVideoUrl, type SampleVideo } from "./samples";

export type SampleVideoStatusKind = "idle" | "loading" | "playing" | "error";

export interface SampleVideoStatus {
  kind: SampleVideoStatusKind;
  message: string;
}

export interface UseSampleVideoStreamOptions {
  /** When false the hook releases the stream and stays idle. */
  isActive: boolean;
  /** The picked sample. Null pauses the hook (e.g. while the user has webcam selected). */
  sample: SampleVideo | null;
  /** Defaults to true. Set false for sources that shouldn't auto-restart at EOF. */
  loop?: boolean;
}

export interface UseSampleVideoStreamResult {
  videoSize: { w: number; h: number };
  status: SampleVideoStatus;
}

export function useSampleVideoStream(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: UseSampleVideoStreamOptions,
): UseSampleVideoStreamResult {
  const { isActive, sample, loop = true } = options;
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [status, setStatus] = useState<SampleVideoStatus>({ kind: "idle", message: "" });

  useEffect(() => {
    if (!isActive || !sample) {
      setStatus({ kind: "idle", message: "" });
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    setStatus({ kind: "loading", message: "Loading clip..." });
    video.crossOrigin = "anonymous";
    video.loop = loop;
    video.muted = true;
    video.src = sampleVideoUrl(sample);

    const syncVideoSize = () => {
      setVideoSize({ w: video.videoWidth || 0, h: video.videoHeight || 0 });
    };
    // `playing` fires once a frame has actually been decoded and the
    // element is rendering live - the correct "the user is seeing pixels"
    // signal. `playing` fires whenever playback resumes from pause/buffer
    // too, which is fine: clearing status during a resume is harmless.
    const onPlaying = () => {
      if (cancelled) return;
      setStatus({ kind: "playing", message: "" });
    };
    const onError = () => {
      if (cancelled) return;
      setStatus({ kind: "error", message: "Clip unavailable" });
      void describeClipFailure(sample).then((message) => {
        if (cancelled) return;
        setStatus({ kind: "error", message });
      });
    };
    video.addEventListener("loadedmetadata", syncVideoSize);
    video.addEventListener("resize", syncVideoSize);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onError);
    void video.play().catch(() => undefined);

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", syncVideoSize);
      video.removeEventListener("resize", syncVideoSize);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onError);
      video.removeAttribute("src");
      video.load();
    };
  }, [isActive, sample, loop, videoRef]);

  return { videoSize, status };
}
