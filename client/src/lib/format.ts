// Shared display formatters used across the recent-events lists,
// summary cards, and chart axes. Every page used to ship its own
// `_formatRelative` / `_formatMs` / `_formatBucketLabel` copy; this
// module is the canonical home so a tweak (e.g. localising the time
// suffix) lands in one place.

/**
 * Render an ISO timestamp as a compact "time since" string suitable
 * for recent-event lists.
 *
 *   < 60s          -> "12s ago"
 *   < 60m          -> "5m ago"
 *   anything older -> the wall-clock time ("14:32:08")
 *
 * Returns "" when the input doesn't parse as a date so callers can
 * render an empty cell rather than "NaN ago".
 */
export function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

/**
 * Render a millisecond duration with a human-readable unit. Used on
 * the Spills "current/last/avg/fastest response" cards.
 *
 *   < 1s   -> "742 ms"
 *   < 10s  -> "4.21s"        (two decimals so a 2-decimal jitter shows)
 *   < 60s  -> "27.4s"
 *   >= 60s -> "1m 12s"
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(2)}s`;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m ${s}s`;
}

/**
 * HH:MM:SS label for chart x-axis bucket timestamps. Used by the
 * Guests + CameraHealth time-series charts where the bucket window
 * is short enough that the date is unambiguous from context.
 */
export function formatBucketLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
