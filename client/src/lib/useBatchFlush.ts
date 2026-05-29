// Batched POST flush queue.
//
// The Plates, CameraHealth, and Guests pages each capture a stream of
// per-tick events (a plate read, a fog observation, a per-zone person
// count) that should land in Lakebase but don't need to survive an
// individual POST failure. They all used the same hand-rolled flush
// loop:
//
//   const pendingRef = useRef<T[]>([]);
//   useEffect(() => {
//     if (!isActive) return;
//     const flush = async () => {
//       const batch = pendingRef.current.splice(0, pendingRef.current.length);
//       if (batch.length === 0) return;
//       try {
//         const res = await fetch(endpoint, { method: "POST", ... body: { batch } });
//         if (!res.ok) pendingRef.current.unshift(...batch);
//       } catch {
//         pendingRef.current.unshift(...batch);
//       }
//     };
//     const id = setInterval(flush, intervalMs);
//     return () => clearInterval(id);
//   }, [isActive]);
//
// The hook below owns the loop; callers keep the ref they push onto so
// they can mutate it from synchronous detector callbacks without needing
// a setter. Failed batches get put back at the FRONT of the queue so
// ordering survives the retry.

import { useEffect, useRef, type MutableRefObject } from "react";

export interface UseBatchFlushOptions {
  /** Pages can toggle the loop on tab-active state. */
  isActive: boolean;
  /** POST endpoint receiving `{ batch: T[] }`. */
  endpoint: string;
  /** How often to flush, in ms. */
  intervalMs: number;
}

/**
 * Returns a stable ref of pending rows. Caller pushes items onto
 * `ref.current` from any handler; the hook flushes the full queue to
 * `endpoint` every `intervalMs`, putting items back at the front on
 * any failure so nothing is silently dropped.
 */
export function useBatchFlush<T>({
  isActive,
  endpoint,
  intervalMs,
}: UseBatchFlushOptions): MutableRefObject<T[]> {
  const pendingRef = useRef<T[]>([]);
  useEffect(() => {
    if (!isActive) return;
    const flush = async () => {
      const batch = pendingRef.current.splice(0, pendingRef.current.length);
      if (batch.length === 0) return;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch }),
        });
        if (!res.ok) pendingRef.current.unshift(...batch);
      } catch {
        pendingRef.current.unshift(...batch);
      }
    };
    const id = setInterval(flush, intervalMs);
    return () => clearInterval(id);
  }, [isActive, endpoint, intervalMs]);
  return pendingRef;
}
