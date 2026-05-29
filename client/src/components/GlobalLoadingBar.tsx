import { useEffect, useRef, useState } from "react";

// Global "something is happening" indicator. Renders a 2px red bar across the
// top of the viewport whenever there is at least one in-flight fetch. Mirrors
// the NProgress / Vercel / GitHub UX so users always have a signal that the
// app is alive, even when a per-section Skeleton sits there for 30s waiting
// for a cold SQL warehouse, a scale-to-zero serving endpoint, or a Lakebase
// first-connect.
//
// Implementation notes:
// - We patch `window.fetch` exactly once at module import. The patch is
//   idempotent (guarded by `_patched`) so HMR doesn't double-wrap.
// - Module-level state + a tiny pub/sub keeps the patch independent of the
//   React tree; any component that imports `loadingBar` can drive the bar
//   manually for non-fetch async work.
// - Progress easing: kick to 15% on first request, then asymptote to 90%
//   while requests are in flight, snap to 100% + fade out when all done.

let _inFlight = 0;
const _listeners = new Set<(n: number) => void>();
let _patched = false;

// Routes that should NOT drive the bar. These are high-frequency / latency-
// inherent calls where a constantly-pulsing bar would be noise:
//   - /api/detect       : per-frame inference (0.5-2 FPS)
//   - /api/plate-ocr    : per-plate OCR follow-up to /api/detect
//   - /api/face-match   : per-frame face recognition (~1 FPS)
//   - /api/face-matches : SSE / recent-list polling for the FR page
//   - /api/serving-status: cold-start poller; already has its own dedicated
//                          warmup UI on the pages that care.
// Match against the URL path so absolute, relative, and Request-object
// inputs all behave the same.
const EXCLUDED_PATHS: readonly string[] = [
  "/api/detect",
  "/api/plate-ocr",
  "/api/face-match",
  "/api/face-matches",
  "/api/serving-status",
];

function _urlPath(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin).pathname;
    if (input instanceof URL) return input.pathname;
    if (input instanceof Request) return new URL(input.url, window.location.origin).pathname;
  } catch {
    // Fall through: malformed inputs just opt back in to showing the bar.
  }
  return "";
}

function _isExcluded(input: RequestInfo | URL): boolean {
  const path = _urlPath(input);
  if (!path) return false;
  return EXCLUDED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

function _notify(): void {
  for (const l of _listeners) l(_inFlight);
}

function _start(): void {
  _inFlight += 1;
  _notify();
}

function _stop(): void {
  _inFlight = Math.max(0, _inFlight - 1);
  _notify();
}

function _patchFetch(): void {
  if (_patched || typeof window === "undefined") return;
  _patched = true;
  const original = window.fetch.bind(window);
  window.fetch = (...args: Parameters<typeof fetch>) => {
    if (_isExcluded(args[0])) return original(...args);
    _start();
    return original(...args).finally(_stop);
  };
}

_patchFetch();

// Exposed for code paths that don't go through `fetch` (e.g. raw EventSource
// connections, WebSockets, file readers). Pair every `start()` with a
// `done()` in a `finally` so the counter doesn't leak.
export const loadingBar = {
  start: _start,
  done: _stop,
};

export function GlobalLoadingBar(): React.ReactElement {
  const [progress, setProgress] = useState(0);
  const pendingRef = useRef(0);

  useEffect(() => {
    let creepTimer: ReturnType<typeof setInterval> | null = null;
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;

    const start = (): void => {
      if (creepTimer) return;
      setProgress(15);
      // Asymptotically approach 90% so the bar always feels alive even on a
      // very slow request. Step size shrinks as we get closer to 90%, so it
      // never quite finishes until the actual request resolves.
      creepTimer = setInterval(() => {
        setProgress((p) => {
          if (pendingRef.current === 0) return p;
          return Math.min(90, p + (90 - p) * 0.08);
        });
      }, 200);
    };

    const finish = (): void => {
      if (creepTimer) {
        clearInterval(creepTimer);
        creepTimer = null;
      }
      setProgress(100);
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => setProgress(0), 350);
    };

    const onChange = (n: number): void => {
      pendingRef.current = n;
      if (n > 0 && !creepTimer) start();
      if (n === 0 && creepTimer) finish();
    };

    _listeners.add(onChange);
    onChange(_inFlight);

    return (): void => {
      _listeners.delete(onChange);
      if (creepTimer) clearInterval(creepTimer);
      if (fadeTimer) clearTimeout(fadeTimer);
    };
  }, []);

  const visible = progress > 0;

  return (
    <div
      aria-hidden
      className="fixed top-0 left-0 right-0 z-[60] h-0.5 pointer-events-none"
    >
      <div
        className="h-full bg-red-500"
        style={{
          width: `${progress}%`,
          opacity: visible && progress < 100 ? 1 : visible ? 0 : 0,
          transition: "width 300ms ease-out, opacity 350ms",
          boxShadow: "0 0 6px rgba(239, 68, 68, 0.55)",
        }}
      />
    </div>
  );
}
