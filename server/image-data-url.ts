// Single source of truth for parsing the `data:image/...;base64,<...>`
// payloads the browser canvas produces and for normalising them into
// the shape each downstream caller needs.
//
// Callers used to duplicate three flavours of the same parse:
//   - server.ts `_stripDataUrl` returned just the base64 body for
//     dataframe_records uploads to Model Serving.
//   - vision-detector.ts `_parseImageDataUrl` returned bytes + mime +
//     dataUrl for hashing, dimension detection, and Claude vision
//     calls.
//   - The plate-OCR route built the canonical `data:image/jpeg;...`
//     prefix inline when the client sent bare base64.
// Centralising the parse here avoids any future drift between the
// three callers and keeps the "what counts as a valid image payload"
// definition in one place.

const _DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/;

export interface ImageDataUrl {
  /** Decoded image bytes (jpeg/png/webp). */
  bytes: Buffer;
  /** MIME type as reported in the data URL, defaulting to `image/jpeg`. */
  mime: string;
  /** Canonical `data:<mime>;base64,<body>` form, useful for LLM payloads. */
  dataUrl: string;
  /** Just the base64 body, useful for Model Serving `dataframe_records`. */
  base64: string;
}

/**
 * Parse an image payload that is either:
 *   1. A `data:image/{jpeg|png|webp};base64,...` URL produced by a
 *      browser canvas, or
 *   2. A bare base64 string (legacy callers + a few mobile clients).
 *
 * Anything else - including unrecognised `data:` URLs - returns null
 * rather than letting an invalid Buffer flow further into the request
 * pipeline. The caller decides what an empty parse means (skip cache,
 * 400 the request, log + return empty detections, ...).
 */
export function parseImageDataUrl(image: string): ImageDataUrl | null {
  const trimmed = image.trim();
  const match = _DATA_URL_RE.exec(trimmed);
  if (match) {
    const mime = match[1];
    const base64 = match[2];
    return {
      bytes: Buffer.from(base64, "base64"),
      mime,
      dataUrl: trimmed,
      base64,
    };
  }
  // Reject `data:`-prefixed payloads that aren't a JPEG/PNG/WEBP
  // base64 URL (e.g. SVG, gzip, mis-encoded) instead of silently
  // round-tripping garbage.
  if (trimmed.startsWith("data:")) return null;
  return {
    bytes: Buffer.from(trimmed, "base64"),
    mime: "image/jpeg",
    dataUrl: `data:image/jpeg;base64,${trimmed}`,
    base64: trimmed,
  };
}

/**
 * Strip the `data:image/...;base64,` prefix and return just the base64
 * body. Returns the input unchanged when it doesn't look like a data
 * URL, matching the historic behaviour of `_stripDataUrl` in server.ts
 * so existing PyFunc serving payloads (which expect bare base64) keep
 * working.
 */
export function toBase64Body(image: string): string {
  return parseImageDataUrl(image)?.base64 ?? image;
}

/**
 * Normalise any accepted image payload to a canonical
 * `data:image/jpeg;base64,...` URL (or whatever real mime came in via
 * a data URL). Bare-base64 callers get a `image/jpeg` prefix because
 * that's what the browser canvas defaults to. Returns null when the
 * input isn't a parseable image payload.
 */
export function toDataUrl(image: string): string | null {
  return parseImageDataUrl(image)?.dataUrl ?? null;
}

/**
 * Decode any accepted image payload to a Buffer for upload / hashing.
 * Returns null when the input isn't parseable - callers should treat
 * a null as a 400-class input error.
 */
export function decodeImage(image: string): Buffer | null {
  return parseImageDataUrl(image)?.bytes ?? null;
}
