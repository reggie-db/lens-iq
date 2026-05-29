// Per-page tick loop with a shared in-flight guard. Previously each page
// had its own setInterval + inFlightRef + try/finally; this hook owns all
// three so pages just supply the async `tick` body.
//
// The guard skips a tick when the previous one hasn't returned yet, which
// is important for /api/detect calls that can take 200-2000ms on cold
// starts: we'd otherwise stack up backed-up requests and the canvas
// overlay would flicker between stale and fresh frames.
import { useEffect, useRef } from "react";

export interface UseDetectionLoopOptions {
  /** When false the loop stops immediately. */
  isActive: boolean;
  /** Milliseconds between successive ticks. The loop respects this as a max rate; if a tick takes longer, the next is scheduled at most one interval later. */
  intervalMs: number;
  /**
   * Optional minimum delay between a tick *completing* and the next
   * one *starting*. Default 0 - the legacy "fire every intervalMs as
   * long as the previous returned" cadence.
   *
   * Use when per-tick cost is high or variable: e.g. face recognition
   * with multiple ArcFace embeddings + pgvector queries per frame can
   * easily take 800-1500ms, which would otherwise peg the loop to
   * "as fast as the endpoint will answer" the moment the in-flight
   * guard releases. A 400-600ms cooldown gives the UI breathing room
   * and prevents tick pileup during cold-start latency spikes, while
   * still letting fast warm-state ticks fire roughly every
   * `intervalMs`.
   */
  cooldownMs?: number;
  /**
   * The async tick body. Run on every interval, but only when the previous
   * one has resolved (the hook holds a ref-based mutex).
   */
  tick: () => Promise<void> | void;
}

export function useDetectionLoop({
  isActive, intervalMs, cooldownMs = 0, tick,
}: UseDetectionLoopOptions): void {
  // Hold the latest tick in a ref so we don't re-arm the setInterval on
  // every render. Pages can pass a closure that captures fresh state and
  // it just works.
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!isActive) return;
    let inFlight = false;
    let cooldownUntil = 0;
    const fire = async () => {
      if (inFlight) return;
      if (Date.now() < cooldownUntil) return;
      inFlight = true;
      try {
        await tickRef.current();
      } finally {
        inFlight = false;
        cooldownUntil = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
      }
    };
    const id = setInterval(fire, intervalMs);
    return () => clearInterval(id);
  }, [isActive, intervalMs, cooldownMs]);
}
