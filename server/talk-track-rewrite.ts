// Foundation-model-backed rewrite for the booth talk track.
//
// The Info page in the UI ships speaker + audience persona dropdowns and
// a length slider. Combining those three knobs into a rewrite of the
// full talk track via the `llm` serving alias (Databricks Foundation
// Model APIs) is what gives the booth presenter a one-click "tune this
// for the badge in front of me" without forking the source markdown.
//
// Caching is keyed by (source-content-hash, speakerPersona,
// audiencePersona, lengthMinutes). The source-content-hash means the
// cache invalidates automatically the moment scripts/sync-presenter-
// content.sh pushes a new revision of dais-talk-track.md - no separate
// bust step. LRU + TTL eviction keeps a single replica from ballooning.
//
// Lives next to vision-detector.ts (its sibling pattern for the same
// "call the llm alias, cache by content hash" idiom).

import crypto from "node:crypto";

import { extractChatText } from "./llm-response.ts";
import { invokeServing, type ServingClient } from "./serving-invoke.ts";

const VISION_ALIAS = "llm";
const _CACHE_MAX_ENTRIES = 64;
const _CACHE_TTL_MS = 60 * 60 * 1000;
const _MAX_TOKENS = 6000;

interface CacheEntry {
  ts: number;
  markdown: string;
}

const _cache = new Map<string, CacheEntry>();

export interface TalkTrackPersonaOptions {
  /** Who is delivering the talk (Solutions Architect, AE, executive...). */
  speakerPersona: string;
  /** Who they are talking to (CFO, VP Ops, LP Director...). */
  audiencePersona: string;
  /** Target read time in minutes. Drives the trim/expand instruction. */
  lengthMinutes: number;
}

function _cacheKey(sourceHash: string, opts: TalkTrackPersonaOptions): string {
  const speaker = opts.speakerPersona.trim().toLowerCase();
  const audience = opts.audiencePersona.trim().toLowerCase();
  return `${sourceHash}|${speaker}|${audience}|${opts.lengthMinutes}`;
}

function _cacheGet(key: string): string | null {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > _CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  // LRU touch.
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.markdown;
}

function _cacheSet(key: string, markdown: string): void {
  _cache.set(key, { ts: Date.now(), markdown });
  while (_cache.size > _CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey === undefined) break;
    _cache.delete(oldestKey);
  }
}

// Plain prose instructions outperform JSON schema scaffolding for this
// task: we want the LLM to think about pacing and audience-fit, not to
// fight a strict envelope. Keep the prompt short - Claude follows tight
// instructions reliably and the source markdown is already the bulk of
// the context window.
function _buildPrompt(source: string, opts: TalkTrackPersonaOptions): string {
  return [
    "You are rewriting a booth talk track for the Data + AI Summit.",
    "Your job is to fit the same content to a specific speaker, a specific audience, and a target read time.",
    "",
    `Speaker persona: ${opts.speakerPersona}`,
    `Audience persona: ${opts.audiencePersona}`,
    `Target read time: ${opts.lengthMinutes} minute(s). Assume the speaker reads roughly 150 words per minute, so the rewritten talk track should be about ${opts.lengthMinutes * 150} words.`,
    "",
    "Hard rules:",
    "- Reply with the rewritten markdown only. No preamble, no closing remarks, no commentary about what you changed.",
    "- Preserve the original markdown structure: keep headings (#, ##, ###), blockquote callouts (>), bullet lists, and fenced code blocks. The page renders the markdown directly.",
    "- Keep every product, model, endpoint, table, and route name spelled exactly the same (e.g. Lakebase, Zerobus, Delta, Unity Catalog, lensiq-detector, pgvector, InsightFace, ArcFace, /faces, /spills, /plates, /clarity, /live, /guests).",
    "- Keep dollar figures, percentages, and timestamps as written. Do not invent new numbers, customer names, or features.",
    "- Rephrase tone, examples, and ordering to fit the speaker/audience. A CFO cares about dollar lines; a CTO cares about architecture; a store manager cares about what changes on the floor; an LP director cares about loss prevention specifics.",
    "- Drop sections that don't fit the target read time. Better to ship 4 strong sections than 9 truncated ones.",
    "- Do not add a meta paragraph about 'this version is for...'; just deliver the rewritten talk track.",
    "",
    "Original talk track follows the divider.",
    "---",
    source,
  ].join("\n");
}

/**
 * Rewrite the talk track for a given speaker/audience/length tuple.
 *
 * Caches successful rewrites by (source content hash, persona tuple) so
 * a repeat request inside the TTL is a Map lookup. Surfaces
 * EndpointNotDeployedError unchanged so the route can return the
 * structured 503 envelope the UI branches on.
 */
export async function rewriteTalkTrack(
  appkit: ServingClient,
  source: string,
  opts: TalkTrackPersonaOptions,
): Promise<{ markdown: string; cached: boolean }> {
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  const key = _cacheKey(sourceHash, opts);
  const cached = _cacheGet(key);
  if (cached !== null) return { markdown: cached, cached: true };

  const prompt = _buildPrompt(source, opts);
  const data = await invokeServing(appkit, VISION_ALIAS, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: _MAX_TOKENS,
  });
  const text = extractChatText(data).trim();
  if (!text) {
    throw new Error("Talk track rewrite returned an empty response.");
  }
  _cacheSet(key, text);
  return { markdown: text, cached: false };
}
