// Gated periodic polling effect.
//
// Several pages used to inline the exact same setInterval idiom for
// "while this tab is active, fetch X once and then every N ms":
//
//   useEffect(() => {
//     if (!isActive) return;
//     void fn();
//     const id = setInterval(() => void fn(), intervalMs);
//     return () => clearInterval(id);
//   }, [isActive, fn]);
//
// This hook owns that pattern so a future tweak (jitter, exponential
// back-off on failure, pause-on-tab-hidden, ...) lands in one place.
// Callers wrap their fetcher in `useCallback` to keep the deps stable;
// the effect re-arms when `fn` changes.

import { useEffect } from "react";

/**
 * Run `fn` immediately and then every `intervalMs` ms while `isActive`
 * is true. The effect cleans up its own interval on unmount or when
 * `isActive` flips false. `fn` may return a promise; the hook does not
 * await it (callers should not block the tick on slow IO).
 */
export function usePollingEffect(
  fn: () => Promise<void> | void,
  { isActive, intervalMs }: { isActive: boolean; intervalMs: number },
): void {
  useEffect(() => {
    if (!isActive) return;
    void fn();
    const id = setInterval(() => void fn(), intervalMs);
    return () => clearInterval(id);
  }, [isActive, intervalMs, fn]);
}
