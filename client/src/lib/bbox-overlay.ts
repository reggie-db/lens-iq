// Shared <canvas>-based bbox overlay used by every detection page. Replaces
// the per-page ad-hoc `useEffect(() => { canvas.getContext('2d')... })`
// blocks that were drifting in style (Live had its own helper, Spills had
// another, etc.). Drawing primitives only - per-page UI chrome (badges,
// status pills) stays in the page.
//
// Coords are in source-image pixels: pass detector outputs scaled with
// `scaleDetectionBbox(... scaleX, scaleY)` if you fed the detector a
// downscaled frame.

export interface OverlayBox {
  bbox: [number, number, number, number];
  color: string;
  /** Optional label (e.g. "person 87%"). Rendered with a filled background pill above the bbox. */
  label?: string;
  /** 0..1 alpha for the filled inside of the bbox. Defaults to 0.18. Set to 0 to leave the inside transparent. */
  fillAlpha?: number;
  /** When the label is too wide to fit above the bbox, alpha for the label's background fill. Defaults to 0.9. */
  labelAlpha?: number;
}

function _hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return `rgba(14, 165, 233, ${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface DrawBboxOverlayOptions {
  /**
   * Set to true when the underlying video is rendered with a mirror
   * (CSS `transform: scaleX(-1)`), as is conventional for selfie /
   * front-camera streams. The function flips bbox x-coordinates so the
   * boxes line up with the mirrored video while keeping label text
   * readable (text is *not* mirrored).
   *
   * Important: when this is `true`, the canvas element itself must
   * **not** carry a CSS mirror transform - the mirroring lives inside
   * the draw call so labels stay legible.
   */
  mirrorX?: boolean;
}

/**
 * Resize the canvas to match the video's intrinsic resolution and draw the
 * supplied boxes. Safe to call with `boxes=[]` to clear.
 *
 * - `videoSize` should be the source-image size in CSS pixels (videoWidth /
 *   videoHeight). When 0 we fall back to the video element's reported size.
 * - The canvas is sized in pixel buffer terms; the CSS layout size is
 *   driven by the page (typically `absolute inset-0 w-full h-full
 *   object-contain` so it letterboxes the same way the underlying video
 *   element does).
 */
export function drawBboxOverlay(
  canvas: HTMLCanvasElement | null,
  video: HTMLVideoElement | null,
  videoSize: { w: number; h: number },
  boxes: OverlayBox[],
  options: DrawBboxOverlayOptions = {},
): void {
  if (!canvas) return;
  const w = videoSize.w || video?.videoWidth || 1280;
  const h = videoSize.h || video?.videoHeight || 720;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (boxes.length === 0) return;

  ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
  const fontSize = Math.max(14, Math.round(canvas.width / 60));
  ctx.font = `${fontSize}px sans-serif`;
  const labelHeight = Math.max(18, Math.round(canvas.width / 50));

  const mirror = options.mirrorX === true;

  for (const box of boxes) {
    const [rawX1, rawY1, rawX2, rawY2] = box.bbox;
    // When the video is mirrored we draw onto an unmirrored canvas
    // and flip the box ourselves. That keeps text in `ctx.fillText`
    // readable; mirroring via CSS would otherwise render the label as
    // its inverted twin.
    const x1 = mirror ? canvas.width - rawX2 : rawX1;
    const x2 = mirror ? canvas.width - rawX1 : rawX2;
    const y1 = rawY1;
    const y2 = rawY2;
    const bw = Math.max(0, x2 - x1);
    const bh = Math.max(0, y2 - y1);
    const fillAlpha = box.fillAlpha ?? 0.18;
    if (fillAlpha > 0 && bw > 0 && bh > 0) {
      ctx.fillStyle = _hexToRgba(box.color, fillAlpha);
      ctx.fillRect(x1, y1, bw, bh);
    }
    ctx.strokeStyle = box.color;
    ctx.strokeRect(x1, y1, bw, bh);

    if (box.label) {
      const padding = 4;
      const tw = ctx.measureText(box.label).width + padding * 2;
      ctx.fillStyle = _hexToRgba(box.color, box.labelAlpha ?? 0.9);
      ctx.fillRect(x1, Math.max(0, y1 - labelHeight), tw, labelHeight);
      ctx.fillStyle = "white";
      ctx.fillText(box.label, x1 + padding, Math.max(labelHeight - padding, y1 - padding));
    }
  }
}
