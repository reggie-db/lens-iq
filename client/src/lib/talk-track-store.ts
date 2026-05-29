// External store for the talk-track rewrite.
//
// The /info page rewrite was originally component-local state: navigating
// away from /info during the LLM call cancelled the fetch and dropped
// the result. Pulling the state and the fetch into module scope means
// the request keeps running even while the presenter scrolls through
// /live or /spills, and the result is waiting for them when they come
// back to /info.
//
// React subscribes via `useSyncExternalStore(subscribe, getState)`.
// Listeners see every state transition (loading -> ready/error). A
// sonner toast also fires on completion so the background work is
// visible from any page.
//
// Caching layers:
//   1. `_cache: Map<key, markdown>`  - per-tab in-memory cache. Repeat
//      clicks on the same persona tuple are instant.
//   2. `_inflight: Map<key, Promise>` - dedupe so rapid double-clicks
//      with the same tuple share one network request.
//   3. The server cache in `server/talk-track-rewrite.ts` is the
//      cross-tab + cross-replica layer. The badge surfaces it as
//      "cached" when the server reports a hit.

import { toast } from "sonner";

import { fetchJson } from "./serving-status";

export interface PersonaOptions {
  speakerPersona: string;
  audiencePersona: string;
  lengthMinutes: number;
}

export type TalkTrackStatus = "idle" | "loading" | "ready" | "error";

export interface TalkTrackRewriteState {
  status: TalkTrackStatus;
  /** The rendered rewrite, or null when status is idle/loading/error. */
  markdown: string | null;
  /** The persona tuple that produced `markdown`. */
  appliedOpts: PersonaOptions | null;
  /** Set when the SERVER reported a cache hit. */
  cached: boolean;
  /** Populated only when status === "error". */
  error: string | null;
  /** The persona tuple currently being requested, when status === "loading". */
  pending: PersonaOptions | null;
}

interface TransformResponse {
  markdown: string;
  cached: boolean;
}

const _INITIAL: TalkTrackRewriteState = {
  status: "idle",
  markdown: null,
  appliedOpts: null,
  cached: false,
  error: null,
  pending: null,
};

let _state: TalkTrackRewriteState = _INITIAL;
const _cache = new Map<string, string>();
const _inflight = new Map<string, Promise<TransformResponse>>();
const _listeners = new Set<() => void>();

function _key(opts: PersonaOptions): string {
  return `${opts.speakerPersona}|${opts.audiencePersona}|${opts.lengthMinutes}`;
}

function _label(opts: PersonaOptions): string {
  return `${opts.speakerPersona} -> ${opts.audiencePersona}, ${opts.lengthMinutes} min`;
}

function _setState(next: Partial<TalkTrackRewriteState>): void {
  _state = { ..._state, ...next };
  for (const listener of _listeners) listener();
}

/** `useSyncExternalStore` snapshot getter. */
export function getTalkTrackState(): TalkTrackRewriteState {
  return _state;
}

/** `useSyncExternalStore` subscribe. Returns the unsubscribe fn. */
export function subscribeTalkTrack(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/**
 * Kick off a talk-track rewrite. Returns immediately; subscribers see
 * the loading -> ready/error transitions. Safe to call from any page;
 * the request and result outlive the calling component.
 *
 * Dedup rules:
 *   - Identical persona tuple already in the in-memory cache: applied
 *     synchronously, no network call.
 *   - Identical persona tuple already in flight: subscribe to that
 *     promise instead of starting a second one.
 *   - Different tuple while another is in flight: the older promise
 *     still completes (so its result lands in the cache), but only
 *     the newest pending tuple actually updates the public state.
 */
export function customizeTalkTrack(opts: PersonaOptions): void {
  const key = _key(opts);
  const label = _label(opts);

  const hit = _cache.get(key);
  if (hit) {
    _setState({
      status: "ready",
      markdown: hit,
      appliedOpts: opts,
      cached: true,
      error: null,
      pending: null,
    });
    return;
  }

  _setState({ status: "loading", pending: opts, error: null });
  toast.info(`Rewriting talk track for ${label}...`, {
    id: `talk-track-rewrite-${key}`,
  });

  let promise = _inflight.get(key);
  if (!promise) {
    promise = fetchJson<TransformResponse>("/api/talk-track/transform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    promise
      .then((res) => {
        _cache.set(key, res.markdown);
      })
      .finally(() => {
        _inflight.delete(key);
      });
    _inflight.set(key, promise);
  }

  promise
    .then((res) => {
      // Only land this result if the user's most recent intent still
      // matches it. Otherwise leave the markdown in the cache and let
      // the newer request own the public state.
      const stillCurrent = _state.pending != null && _key(_state.pending) === key;
      if (!stillCurrent) return;
      _setState({
        status: "ready",
        markdown: res.markdown,
        appliedOpts: opts,
        cached: res.cached,
        error: null,
        pending: null,
      });
      toast.success(`Talk track ready (${label})`, {
        id: `talk-track-rewrite-${key}`,
      });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const stillCurrent = _state.pending != null && _key(_state.pending) === key;
      if (!stillCurrent) return;
      _setState({ status: "error", error: message, pending: null });
      toast.error(`Talk track rewrite failed: ${message}`, {
        id: `talk-track-rewrite-${key}`,
      });
    });
}

/** Clear the active rewrite so the page falls back to the original markdown. */
export function resetTalkTrack(): void {
  _setState(_INITIAL);
}
