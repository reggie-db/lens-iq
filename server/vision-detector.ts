// Generic Claude-vision-backed object detector.
//
// Why this exists:
//   Off-the-shelf Roboflow models trained on lab spills, generic
//   traffic cones, etc. miss the subtle wet patches and the
//   miscellaneous caution cones you actually see in supermarket
//   CCTV. On our canonical aisle clip every public spill model
//   either ignored the wet patch or fired on people, shelves,
//   and shopping baskets; the cone-detection models had similar
//   misfires without aggressive geometric filters.
//
// What we do instead:
//   One vision call per frame asks a Databricks-hosted foundation
//   model (Claude on the shared `llm` alias) to locate every
//   instance of a caller-supplied label list, returning a JSON
//   array of labelled boxes. Multiple /api/detect calls that
//   reference the same image + label set share one Claude round-
//   trip via the SHA-256 image-hash LRU cache.
//
// API:
//   detectWithClaude(appkit, image, { labels, promptAddendum? })
//     -> { label, confidence, bbox }[]
//   The returned list contains EVERY label match found; the caller
//   is responsible for filtering down to a specific label or
//   applying a confidence floor.
//
// Caveats:
//   - Latency: 3-5s per cold call. Fixed-camera demo clips loop,
//     so the first pass populates the cache and every subsequent
//     loop resolves in microseconds.

import crypto from "node:crypto";

import { parseImageDataUrl } from "./image-data-url";
import { extractChatText, extractJsonObject } from "./llm-response";
import { invokeServing, type ServingClient } from "./serving-invoke";

export interface VisionDetection {
  /** One of the labels the caller asked for. */
  label: string;
  /** 0-1 calibrated confidence as reported by the model. */
  confidence: number;
  /** [x1, y1, x2, y2] in the same pixel coord space as the input image. */
  bbox: [number, number, number, number];
  /** Optional one-line model rationale (Claude often includes it). */
  reason?: string;
}

const VISION_ALIAS = "llm";
const MAX_TOKENS = 512;
const _CACHE_MAX_ENTRIES = 256;
const _CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  ts: number;
  detections: VisionDetection[];
}

const _cache = new Map<string, CacheEntry>();

function _cacheGet(key: string): VisionDetection[] | null {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > _CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.detections;
}

function _cacheSet(key: string, detections: VisionDetection[]): void {
  _cache.set(key, { ts: Date.now(), detections });
  while (_cache.size > _CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey === undefined) break;
    _cache.delete(oldestKey);
  }
}

// Read width/height out of a JPEG/PNG header without pulling in an
// image lib. We only need approximate pixel dimensions to anchor
// the model's bbox coordinates; failure falls back to a default.
function _imageSize(bytes: Buffer, mime: string): { w: number; h: number } | null {
  if (mime === "image/png" && bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  if (mime === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      i += 2;
      if (marker === 0xd8 || marker === 0xd9) return null;
      const len = bytes.readUInt16BE(i);
      const sof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) {
        return { h: bytes.readUInt16BE(i + 3), w: bytes.readUInt16BE(i + 5) };
      }
      i += len;
    }
  }
  return null;
}

function _hashImage(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function _cacheKey(imageHash: string, labels: readonly string[], addendum: string): string {
  // Sort labels so ["spill","cone"] and ["cone","spill"] share a
  // cache entry; the model returns the same hits either way.
  const sorted = [...labels].map((l) => l.trim().toLowerCase()).sort();
  return `${imageHash}|${sorted.join(",")}|${crypto.createHash("sha1").update(addendum).digest("hex").slice(0, 12)}`;
}

// Open-ended prompt template. Earlier strict variants
// ("ignore shadows, ignore shelves, ignore clothing, look only at
// the floor between shelf rows") pushed Claude past its no-detection
// threshold on subtle CCTV frames. Mirroring the ChatGPT-4o phrasing
// that worked ("can you detect a spill in this image?") consistently
// surfaces the actual hits without scene-specific babysitting.
function _buildPrompt(labels: readonly string[], w: number, h: number, addendum: string): string {
  const labelList = labels.map((l) => `"${l}"`).join(", ");
  const labelTypeUnion = labels.map((l) => `"${l}"`).join("|");
  const base = `Can you detect any of the following in this image: ${labelList}?
Respond as quickly as possible with bounding boxes and confidences
(there can be multiple of each, or none).

Image is ${w}x${h} pixels, origin (0,0) top-left.

Reply with ONLY a single line of JSON, no markdown:
{"detections":[{"label":${labelTypeUnion},"bbox":[x1,y1,x2,y2],"confidence":0.0,"reason":"short"}]}

If you see nothing, reply: {"detections":[]}`;
  return addendum.trim() ? `${base}\n\nAdditional context: ${addendum.trim()}` : base;
}

// Tolerate a few JSON response shapes the model can produce:
//   1. {"detections":[{label, bbox, confidence}, ...]}      (preferred)
//   2. [{label, bbox, confidence}, ...]                      (bare array)
//   3. {label, bbox, confidence}                             (single hit)
//   4. {"<label>":[{bbox, confidence}, ...]}                (label-keyed groups)
// bbox can be [x1,y1,x2,y2] or {x,y,width,height} (the latter is
// what ChatGPT-4o emits by default).
function _parseResponse(raw: string, allowedLabels: readonly string[]): VisionDetection[] {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  type RawRec = Record<string, unknown> & { __forced_label?: string };
  const items: RawRec[] = [];
  const pushAll = (arr: unknown, forced?: string) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === "object") {
        const rec = { ...item } as RawRec;
        if (forced) rec.__forced_label = forced;
        items.push(rec);
      }
    }
  };
  const lcLabels = allowedLabels.map((l) => l.toLowerCase());

  if (Array.isArray(parsed)) {
    pushAll(parsed);
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.detections)) pushAll(obj.detections);
    // Label-keyed groups e.g. {"spills":[...], "cones":[...]}.
    // Try both the exact label and a few common plural variants.
    for (const lbl of lcLabels) {
      if (Array.isArray(obj[lbl])) pushAll(obj[lbl], lbl);
      const plural = `${lbl}s`;
      if (plural !== lbl && Array.isArray(obj[plural])) pushAll(obj[plural], lbl);
    }
    if (items.length === 0 && obj.bbox != null) pushAll([obj]);
  }

  const out: VisionDetection[] = [];
  for (const rec of items) {
    const bbox = _coerceBbox(rec.bbox);
    if (!bbox) continue;
    const label = _coerceLabel(rec.label, rec.__forced_label, lcLabels);
    if (!label) continue;
    const conf = typeof rec.confidence === "number" ? rec.confidence : 0.75;
    out.push({
      label,
      confidence: conf,
      bbox,
      reason: typeof rec.reason === "string" ? rec.reason : undefined,
    });
  }
  return out;
}

function _coerceLabel(
  value: unknown,
  forced: string | undefined,
  allowedLowerLabels: readonly string[],
): string | null {
  const candidate = forced ?? (typeof value === "string" ? value : null);
  if (!candidate) return null;
  const v = candidate.trim().toLowerCase();
  // Exact match.
  if (allowedLowerLabels.includes(v)) return v;
  // Plural variants and a couple of common synonyms so we
  // don't have to teach every caller to do the same string
  // gymnastics. Synonyms ONLY map to labels the caller asked for.
  const singular = v.endsWith("s") ? v.slice(0, -1) : v;
  if (allowedLowerLabels.includes(singular)) return singular;
  if ((v === "liquid" || v === "puddle" || v === "wet-patch") && allowedLowerLabels.includes("spill")) return "spill";
  if ((v === "wet_floor_sign" || v.includes("caution") || v.includes("wet floor")) && allowedLowerLabels.includes("cone")) return "cone";
  // Pizza-slice synonyms. Claude sometimes drops the underscore or the
  // qualifier, so map natural variants back to the canonical label
  // when the caller asked for "pizza_slice".
  if (
    allowedLowerLabels.includes("pizza_slice")
    && (v === "slice" || v === "pizza slice" || v === "pizzaslice" || v === "slice of pizza" || v === "pizza_slice")
  ) {
    return "pizza_slice";
  }
  // Pizza-pie (whole uncut pizza) synonyms. Bare "pizza" is allowed
  // only when the caller explicitly asked for pizza_pie - otherwise
  // an unrelated "pizza" label from a generic detector would collide
  // with the pizza_slice path. The pizza_inventory + pizza_pie group
  // always passes both labels together so this branch is safe.
  if (
    allowedLowerLabels.includes("pizza_pie")
    && (
      v === "pie"
      || v === "pizza"
      || v === "pizza pie"
      || v === "pizzapie"
      || v === "whole pizza"
      || v === "whole pie"
      || v === "uncut pizza"
      || v === "uncut pie"
      || v === "round pizza"
      || v === "pizza_pie"
    )
  ) {
    return "pizza_pie";
  }
  return null;
}

function _coerceBbox(value: unknown): [number, number, number, number] | null {
  if (Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number")) {
    return value.map((v) => Math.round(Number(v))) as [number, number, number, number];
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const has = (k: string) => typeof obj[k] === "number";
    if (has("x") && has("y") && has("width") && has("height")) {
      const x = Math.round(obj.x as number);
      const y = Math.round(obj.y as number);
      const w = Math.round(obj.width as number);
      const h = Math.round(obj.height as number);
      return [x, y, x + w, y + h];
    }
    if (has("x1") && has("y1") && has("x2") && has("y2")) {
      return [
        Math.round(obj.x1 as number),
        Math.round(obj.y1 as number),
        Math.round(obj.x2 as number),
        Math.round(obj.y2 as number),
      ];
    }
  }
  return null;
}

// Reject bboxes that wandered out of frame, collapsed to a
// degenerate rect, or grew large enough that they're almost certainly
// a hallucination (vision models occasionally answer "the whole
// image" when uncertain).
function _isPlausibleBbox(
  bbox: [number, number, number, number],
  w: number,
  h: number,
): boolean {
  const [x1, y1, x2, y2] = bbox;
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return false;
  if (x1 < 0 || y1 < 0) return false;
  if (x2 > w || y2 > h) return false;
  if (x2 - x1 < 4 || y2 - y1 < 4) return false;
  const area = (x2 - x1) * (y2 - y1);
  if (area / (w * h) > 0.5) return false;
  return true;
}

export interface DetectWithClaudeOptions {
  /** Object types to detect, e.g. ["spill", "cone"]. Case-insensitive. */
  labels: readonly string[];
  /**
   * Optional extra instructions appended to the default prompt. Use
   * for scene-specific hints ("the camera looks down the aisle, the
   * floor is light grey") or scope qualifiers ("only flag spills
   * larger than a coin"). Kept out of the cache key by hashing.
   */
  promptAddendum?: string;
}

/**
 * Run a single Claude-vision call against `image` and return every
 * box matching any of `labels`, with each detection carrying its
 * own label + confidence.
 *
 * The result is cached by (image bytes, label set, prompt addendum)
 * so repeat callers - e.g. /api/detect for `spill` then `wet_floor_sign`
 * on the same frame - share one round-trip.
 *
 * The returned bbox is in the SAME pixel coordinate space as the
 * `image` data URL passed in. The Spills page already scales to
 * full-res video pixels via scaleDetectionBbox().
 */
export async function detectWithClaude(
  appkit: ServingClient,
  image: string,
  options: DetectWithClaudeOptions,
): Promise<VisionDetection[]> {
  const labels = options.labels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (labels.length === 0) return [];

  const parsed = parseImageDataUrl(image);
  if (!parsed) return [];

  const addendum = options.promptAddendum ?? "";
  const imageHash = _hashImage(parsed.bytes);
  const key = _cacheKey(imageHash, labels, addendum);
  const cached = _cacheGet(key);
  if (cached !== null) return cached;

  const dims = _imageSize(parsed.bytes, parsed.mime);
  const w = dims?.w ?? 1280;
  const h = dims?.h ?? 720;
  const prompt = _buildPrompt(labels, w, h, addendum);

  let raw = "";
  try {
    const data = await invokeServing(appkit, VISION_ALIAS, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: parsed.dataUrl } },
          ],
        },
      ],
      max_tokens: MAX_TOKENS,
    });
    raw = extractChatText(data).trim();
  } catch (err) {
    // EndpointNotDeployedError needs to propagate so /api/detect can
    // return its structured 503 envelope; everything else becomes
    // "no detections" plus a console warning so a single bad model
    // call doesn't blank the page.
    if (err instanceof Error && err.name === "EndpointNotDeployedError") throw err;
    console.warn("[vision] LLM call failed:", err instanceof Error ? err.message : err);
    _cacheSet(key, []);
    return [];
  }

  const hits = _parseResponse(raw, labels);
  if (hits.length === 0) {
    const looksEmpty = raw.includes("\"detections\":[]") || /"\w+":\s*\[\s*\]/.test(raw);
    if (raw.length > 0 && !looksEmpty) {
      console.warn("[vision] could not parse LLM response:", raw.slice(0, 240));
    }
    _cacheSet(key, []);
    return [];
  }

  const valid: VisionDetection[] = [];
  for (const hit of hits) {
    if (!_isPlausibleBbox(hit.bbox, w, h)) {
      console.warn("[vision] implausible bbox dropped:", hit.label, hit.bbox, `(image ${w}x${h})`);
      continue;
    }
    valid.push(hit);
  }
  _cacheSet(key, valid);
  return valid;
}
