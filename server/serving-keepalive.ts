// Keep registered Model Serving endpoints warm during business hours.
//
// Why this exists: every custom-model endpoint in this app (YOLO,
// Roboflow license-plate, Roboflow slip-fall, Pillow fog detector,
// InsightFace face recognition) is configured with
// `scale_to_zero_enabled: true`. Cold-start latency on a fresh
// invocation is ~30-60 s, which kills the demo experience when a
// presenter walks up to the booth between conversations. This worker
// fires an empty invoke against every registered alias every 15 s
// during the working window so the autoscaler keeps at least one
// replica hot.
//
// Empty payloads are intentional: the autoscaler counts *requests*,
// not successful responses. A 400 from "missing required field" still
// reset the scale-to-zero timer the same as a real call. We swallow
// every response (success or error) so the loop never disturbs the
// rest of the app, and never logs in steady state - errors at startup
// or when an alias is decommissioned are surfaced once.
//
// Aliases come from SERVING_ALIASES (server/serving-aliases.ts) and
// are filtered to those whose env var is actually populated, matching
// the runtime filter in server/server.ts. That keeps this worker in
// lockstep with whatever endpoints the deploy actually bound; an
// endpoint that wasn't deployed (e.g. Roboflow when ROBOFLOW_API_KEY
// is unset) is silently skipped.
//
// Toggle:
//   SERVING_ENDPOINT_KEEP_ALIVE=false   disable the worker entirely.
//   any other value (default unset)     worker runs.

import { SERVING_ALIASES } from "./serving-aliases";

const _TICK_MS = 15_000;
const _WINDOW_TIMEZONE = "America/Los_Angeles";
// 6am Eastern == 3am Pacific. 10pm Pacific stays 10pm Pacific. Working
// in a single timezone (Pacific) sidesteps DST math; both endpoints of
// the window track DST together since they're expressed against the
// same zone the runtime reports.
const _WINDOW_START_HOUR_PT = 3;
const _WINDOW_END_HOUR_PT = 22;
const _LOG_PREFIX = "[serving-keepalive]";

interface ServingClient {
  serving: (alias: string) => {
    invoke: (payload: Record<string, unknown>) => Promise<unknown>;
  };
}

function _isEnabled(): boolean {
  const raw = (process.env.SERVING_ENDPOINT_KEEP_ALIVE ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "no";
}

function _activeAliases(): string[] {
  return Object.entries(SERVING_ALIASES)
    .filter(([, cfg]) => Boolean(process.env[cfg.envVar]))
    .map(([alias]) => alias);
}

function _hourIn(timezone: string, now: Date = new Date()): number {
  // Intl returns a string like "03" with hourCycle h23. Parse to a
  // 0-23 integer so the comparison below is plain arithmetic.
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(now);
  const parsed = parseInt(formatted, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

export function inKeepAliveWindow(now: Date = new Date()): boolean {
  const hour = _hourIn(_WINDOW_TIMEZONE, now);
  return hour >= _WINDOW_START_HOUR_PT && hour < _WINDOW_END_HOUR_PT;
}

/**
 * Start the keep-alive worker. Returns a stop function for tests; in
 * normal app lifetime nothing calls stop() and Node tears the interval
 * down on process exit.
 */
export function startServingKeepAlive(appkit: ServingClient): () => void {
  if (!_isEnabled()) {
    console.warn(`${_LOG_PREFIX} disabled via SERVING_ENDPOINT_KEEP_ALIVE`);
    return () => {};
  }
  const aliases = _activeAliases();
  if (aliases.length === 0) {
    console.warn(`${_LOG_PREFIX} no active aliases (env vars unset) - not starting`);
    return () => {};
  }
  console.log(
    `${_LOG_PREFIX} ping every ${_TICK_MS / 1000}s during ` +
      `${_WINDOW_START_HOUR_PT}:00-${_WINDOW_END_HOUR_PT}:00 ${_WINDOW_TIMEZONE}` +
      ` (aliases: ${aliases.join(", ")})`,
  );

  const tick = () => {
    if (!inKeepAliveWindow()) return;
    for (const alias of aliases) {
      // Fire-and-forget. Any HTTP status (including 4xx from "empty
      // payload") resets the autoscaler's idle timer, which is all we
      // care about. Swallow rejections so an unhealthy endpoint can't
      // crash the worker via unhandledRejection.
      appkit.serving(alias).invoke({}).catch(() => {});
    }
  };
  const interval = setInterval(tick, _TICK_MS);
  // Don't keep the Node event loop alive solely on account of this
  // timer; if the rest of the app exits, the worker should too.
  if (typeof interval.unref === "function") interval.unref();
  // Fire one immediately when we boot inside the window so the demo is
  // warm by the time the first user clicks something.
  tick();
  return () => clearInterval(interval);
}
