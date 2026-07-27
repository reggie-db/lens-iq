// Curated catalog of sample input videos for the Live page demo.
//
// Two source flavors are supported, but every catalog entry today is
// `local` so the booth demo has no external CDN dependency:
//   - `local` (used by every entry below): filename that lives both in
//     client/public/sample-videos/ on disk AND in the `sample_videos` UC
//     volume. server.ts resolves these in this order: local file
//     (Range-aware fast path for dev), then the volume via the AppKit
//     files plugin (deployed apps - the bundle excludes the MP4s from
//     the app source upload to stay under the 10MB per-file Apps limit,
//     so the SP reads from the volume in prod).
//   - `upstream` (no entries today, kept on the type for future use):
//     cross-origin MP4 hosted on a CDN. server.ts proxies it through to
//     strip CORS for canvas capture.
//
// Either way the client only ever hits /api/sample-videos/:id; the server
// picks the right source. Everything runs as the app SP - no OBO.
//
// `models` lists the LensIQ model ids (see ./models.ts) that the sample is a
// good demo for - the UI uses this to suggest a relevant detector when the
// user picks a source.

import type { ModelDefinition } from "./models";

// Slowed playback speed for the LLM-vision demo pages (Spills, Pizza, Pump,
// Beer, ...). Claude vision costs 3-5s per uncached frame, so at 1x the
// overlay falls behind and every captured frame is a fresh scene (zero cache
// reuse). Playing at ~0.5x lets the detector keep pace and makes consecutive
// captures similar enough that the server's perceptual-hash cache collapses
// them onto one model call. Tune toward 1 for liveliness, lower for accuracy.
export const VISION_PLAYBACK_RATE = 0.5;

export interface SampleVideo {
  id: string;
  name: string;
  description: string;
  /** Upstream URL (cross-origin). Mutually exclusive with `local`. */
  upstream?: string;
  /** Filename under client/public/sample-videos/. Mutually exclusive with `upstream`. */
  local?: string;
  /** Model ids this sample is a good demo for. First entry is the default. */
  models: string[];
}

export const SAMPLE_VIDEOS: SampleVideo[] = [
  // Booth "live feed". Surfaced under the Live page's "Live" group (not the
  // "Sample clips" group) and used as the default source there in place of the
  // device webcam, so an unattended booth display shows a recognizable Data +
  // AI Summit expo-floor crowd that the general YOLO detector boxes as people.
  // ~14s loop cut from official Summit expo-hall b-roll.
  {
    id: "expo-floor",
    name: "Databricks Summit expo floor",
    description: "Crowds walking the Data + AI Summit exhibition hall: booth aisles and the main expo floor. Live falls back to this clip when the webcam is unavailable; YOLO boxes the attendees as people.",
    local: "databricks-summit-expo-floor.mp4",
    models: ["yolo"],
  },
  {
    id: "vehicles",
    name: "Highway traffic",
    description: "Vehicles moving on a multi-lane highway. Great for license plate + general YOLO detection.",
    local: "highway-vehicles.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "vehicles-2",
    name: "Highway traffic (alt angle)",
    description: "Second highway clip, different angle. Same use cases as the primary vehicles clip.",
    local: "highway-vehicles-alt.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "people-walking",
    name: "Pedestrians",
    description: "Outdoor sidewalk with multiple pedestrians walking. Ideal for people count.",
    local: "pedestrians-sidewalk.mp4",
    models: ["yolo"],
  },
  {
    id: "subway",
    name: "Subway crowd",
    description: "Dense subway crowd. Stress-tests people count and YOLO person detection.",
    local: "subway-crowd.mp4",
    models: ["yolo"],
  },
  {
    id: "market-square",
    name: "Market square",
    description: "Outdoor market scene with foot traffic. Good for people count + general YOLO.",
    local: "market-square.mp4",
    models: ["yolo"],
  },
  {
    id: "grocery-store",
    name: "Grocery store aisle",
    description: "Indoor retail aisle. Closest analog to a QSR/c-store interior - shoppers and products.",
    local: "grocery-store-aisle.mp4",
    models: ["yolo"],
  },
  {
    id: "milk-bottling-plant",
    name: "Industrial workers",
    description: "Workers on an industrial line, often with PPE. Useful for general person detection.",
    local: "industrial-ppe-line.mp4",
    models: ["yolo"],
  },

  // ---------------------------------------------------------------------------
  // QSR / c-store / gas station CCTV clips. Shipped locally under
  // client/public/sample-videos/ so we can demo on real-world surveillance
  // angles that look like what a customer would actually pipe into LensIQ.
  // ---------------------------------------------------------------------------
  {
    id: "forecourt-essar",
    name: "Gas station forecourt (CCTV)",
    description: "Daytime forecourt CCTV from a petrol station. Cars at pumps, plates in view - exercises license_plate + general yolo. Also doubles as the `clear` baseline for the fog_detector.",
    local: "forecourt-essar.mp4",
    models: ["license_plate", "yolo", "fog_detector"],
  },
  {
    id: "forecourt-pump",
    name: "Gas pump close-up (CCTV)",
    description: "Pump-level surveillance camera, daytime. Customers refueling, plates visible. Built for license_plate; works with yolo.",
    local: "forecourt-securus-pump.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "cstore-interior",
    name: "C-store interior (CCTV)",
    description: "HD overhead CCTV inside a convenience store: aisles, customers, register area. Strong fit for YOLO person detection and the `clear` baseline for the fog_detector when paired with cstore-foggy-lens.",
    local: "cstore-hd-cctv.mp4",
    models: ["yolo", "fog_detector"],
  },
  {
    id: "aisle-spill-then-cone",
    name: "Aisle spill then cone deployed (CCTV)",
    description: "UK supermarket aisle CCTV (timestamped 2020-10-05 15:08). A wet patch is visible on the floor for the first ~26 seconds with shoppers walking past, then a worker deploys a yellow CAUTION WET FLOOR cone at ~27s. The canonical end-to-end source for the spill -> wet_floor_sign storyline: the spill detector fires throughout, then the wet_floor_sign detector kicks in once the cone is on the floor.",
    local: "aisle-spill-then-cone.mp4",
    models: ["spill", "wet_floor_sign", "yolo"],
  },
  {
    id: "lobby-wet-floor-cctv",
    name: "Lobby with wet-floor cone (CCTV)",
    description: "Real lobby CCTV with timestamp watermark and a yellow wet-floor cone deployed mid-frame. Drives the full wet_floor_sign + slip_fall storyline in one clip.",
    local: "slip-fall-securitycam.mp4",
    models: ["wet_floor_sign", "slip_fall", "yolo"],
  },
  {
    id: "qsr-cafe-cctv",
    name: "QSR cafe interior (CCTV)",
    description: "Multi-angle restaurant CCTV with timestamp watermark - customers at tables and counter. Strong fit for YOLO person detection and slip_fall as people move through the dining area.",
    local: "slip-fall-oviss.mp4",
    models: ["slip_fall", "yolo"],
  },
  {
    id: "wet-floor-cone-closeup",
    name: "Wet floor cone close-up",
    description: "Hand-held demo of a yellow pop-up wet-floor cone deployed in a lobby. Best used to sanity-check the wet_floor_sign detector on a clean, well-lit cone.",
    local: "cone-pop-up-demo.mp4",
    models: ["wet_floor_sign"],
  },
  {
    id: "plates-daytime",
    name: "Plate-readable street CCTV",
    description: "Street-level CCTV with timestamp watermark. Plates are large and legible enough for Claude vision OCR. Best clip for the License Plates live demo.",
    local: "plates-daytime.mp4",
    models: ["license_plate", "yolo"],
  },

  // ---------------------------------------------------------------------------
  // Fog / camera-health diagnostic clips. Synthetic partial-fog variants of
  // the clear CCTV samples above, produced offline with ffmpeg using a
  // radial Gaussian mask centered on the frame (`maskedmerge` of a blurred
  // copy onto the original):
  //   geq=lum='255*exp(-(pow(X-W/2,2)+pow(Y-H/2,2))/(2*pow(SIGMA,2)))'
  // The result is a soft fog blob smudged across the middle of the frame
  // while the edges stay crisp - mimics a real contaminated dome camera
  // (smudge / condensation / spit) instead of uniform image-wide blur.
  // The patch-based fog_detector PyFunc localizes the fog to a single bbox
  // around the affected region instead of a full-frame banner. Pair each
  // foggy clip with its clear baseline to demo the verdict flipping.
  // ---------------------------------------------------------------------------
  {
    id: "cstore-foggy-lens",
    name: "C-store interior (foggy lens)",
    description: "Synthetic partial-fog version of cstore-interior - center of the lens is heavily smudged, edges are clear. Drives the fog_detector to emit a localized `fogged` bbox over the smudged register area while the rest of the store stays detectable for the other models.",
    local: "cstore-foggy-lens.mp4",
    models: ["fog_detector", "yolo"],
  },
  {
    id: "forecourt-foggy-lens",
    name: "Gas station forecourt (foggy lens)",
    description: "Synthetic partial-fog version of forecourt-essar - same vantage with a center smudge on the lens. Cars at the pumps are obscured but the storefront + signage stay legible. Drives the fog_detector to localize a `fogged` bbox over the smudged region.",
    local: "forecourt-foggy-lens.mp4",
    models: ["fog_detector", "license_plate"],
  },

  // ---------------------------------------------------------------------------
  // In-store freezer aisle cameras. Real CCTV-style footage of shoppers at
  // glass-door freezer cases (the most common venue for lens-condition
  // failures: cold air + warm aisle = condensation on a dome cam). Sourced
  // from Mixkit (mixkit-man-chooses-products-from-supermarket-refrigerators
  // and the matching woman-at-freezer clip). The `foggy-lens` variant is
  // synthesized from the clear clip with the same radial Gaussian mask
  // recipe used for cstore-foggy-lens / forecourt-foggy-lens.
  // ---------------------------------------------------------------------------
  {
    id: "freezer-aisle",
    name: "Freezer aisle (CCTV)",
    description: "Daytime overhead-ish shot of a shopper opening a glass-door freezer case in a supermarket frozen-foods aisle. Crisp lens, full reach visible. Clear baseline for the fog_detector when paired with freezer-aisle-foggy-lens.",
    local: "freezer-aisle.mp4",
    models: ["fog_detector", "yolo"],
  },
  {
    id: "freezer-aisle-foggy-lens",
    name: "Freezer aisle (foggy lens)",
    description: "Synthetic partial-fog version of freezer-aisle - same vantage with a heavy center-blob smudge over the freezer door the shopper is opening. The fog blob obscures the very person a loss-prevention model needs to see, which is the whole point of the fog_detector flagging this camera for cleaning.",
    local: "freezer-aisle-foggy-lens.mp4",
    models: ["fog_detector", "yolo"],
  },
  {
    id: "freezer-aisle-alt",
    name: "Freezer chest cooler (CCTV)",
    description: "Second freezer angle: a shopper standing at glass-fronted upright coolers full of frozen food, side-on view. Brighter, more product-dense backdrop than freezer-aisle. Useful as an alternate clear baseline for the fog_detector and as a second source on the Camera Health side-by-side view.",
    local: "freezer-aisle-alt.mp4",
    models: ["fog_detector", "yolo"],
  },

  // ---------------------------------------------------------------------------
  // Grocery produce aisle - the canonical Camera Health demo pair. Wide-angle
  // store interior view with shoppers, refrigerated produce cases on the
  // left, central baskets of fruit, and visible store signage / weigh
  // station - ideal stage for showing how a fogged lens degrades a
  // general-purpose CCTV feed (vs the freezer-only clips which are tighter
  // and less recognizable as "the camera over the store"). Sourced from
  // Pexels (video 15754278, hd_1280_720_24fps). The `foggy-lens` variant is
  // synthesized from the clear clip with the same radial Gaussian mask used
  // for the other foggy variants.
  // ---------------------------------------------------------------------------
  {
    id: "grocery-produce-aisle",
    name: "Grocery produce aisle (CCTV)",
    description: "Wide-angle daytime CCTV of a grocery store produce section: refrigerated produce cases, central baskets of apples and kiwi, shoppers and a cashier visible, store signage above. Crisp lens, every shelf legible. Default clear baseline for the fog_detector when paired with grocery-produce-aisle-foggy-lens.",
    local: "grocery-produce-aisle.mp4",
    models: ["fog_detector", "yolo"],
  },
  {
    id: "grocery-produce-aisle-foggy-lens",
    name: "Grocery produce aisle (foggy lens)",
    description: "Synthetic partial-fog version of grocery-produce-aisle - same vantage with a heavy center-blob smudge over the weigh station and central produce baskets. The fog hides the busiest area of the camera's field of view while shopping carts at the edges stay sharp, which is the exact failure mode the fog_detector is designed to catch before downstream models miss shoplifters / spills.",
    local: "grocery-produce-aisle-foggy-lens.mp4",
    models: ["fog_detector", "yolo"],
  },

  // ---------------------------------------------------------------------------
  // QSR pizza counter cameras. Clean stock pizza clips (Mixkit) degraded into
  // security-camera footage offline with scripts/synth_cctv_look.sh: 12fps,
  // 720p, desaturated + contrast/gamma pulled toward a cheap sensor, light
  // lens blur, per-frame grain, vignette, and a burnt-in HUD (running clock,
  // "CAM NN" label, blinking REC). The pizza stays large and centered so the
  // COCO `pizza` class fires cleanly while the frame reads as surveillance -
  // the canonical "pizza on a counter" source for the yolo live demo.
  // ---------------------------------------------------------------------------
  {
    id: "pizza-counter-overhead",
    name: "Pizza counter overhead (CCTV)",
    description: "Top-down counter camera over a whole pepperoni pizza, a hand reaching in for a slice. The cleanest single-object `pizza` shot - default clip for the yolo pizza demo.",
    local: "pizza-counter-overhead.mp4",
    models: ["yolo"],
  },
  {
    id: "pizza-counter-dinein",
    name: "Pizza dining table (CCTV)",
    description: "High-angle dining-area camera: a pepperoni pizza on a board with several hands taking slices, plus cups and plates around it. Exercises YOLO pizza, cup, and person detection.",
    local: "pizza-counter-dinein.mp4",
    models: ["yolo"],
  },
  {
    id: "pizza-counter-prep",
    name: "Pizza prep station (CCTV)",
    description: "Tight prep-station camera filling the frame with a fresh pepperoni pie. High-confidence single `pizza` detection for stress-testing the yolo endpoint.",
    local: "pizza-counter-prep.mp4",
    models: ["yolo"],
  },
  {
    id: "pizza-counter-cut",
    name: "Pizza cut station (CCTV)",
    description: "Cut-station camera as a pizza wheel rolls through a loaded pie. Moving object in frame - good for showing per-frame yolo detection holding across motion.",
    local: "pizza-counter-cut.mp4",
    models: ["yolo"],
  },

  // ---------------------------------------------------------------------------
  // Pizza slice inventory. Separate from the generic "QSR pizza counter"
  // CCTV clips above because this stage of the storyline is about
  // available-slice counting (a Claude-vision-only flow), not
  // generic YOLO `pizza` detection. The clip shows a pepperoni pie
  // partially cut into wedges with hands lifting slices off the board -
  // the canonical source for the pizza_inventory model. Use the model
  // to estimate how many slices remain, then alert hot-hold staff when
  // the count crosses a low-stock threshold.
  // ---------------------------------------------------------------------------
  {
    id: "pizza-slice-inventory",
    name: "Pizza slice inventory (counter cam)",
    description: "Counter camera over a partially-sliced pepperoni pizza with diners lifting wedges off the board. Each visible slice becomes a separate Claude vision bbox, and the count of detections IS the available-slice estimate driving hot-hold restock alerts.",
    local: "pizza-slice-inventory.mp4",
    models: ["pizza_inventory", "pizza_pie", "yolo"],
  },

  // ---------------------------------------------------------------------------
  // Gas-station pump out-of-service detection. A bag (or plastic cover) tied
  // over a fuel nozzle/dispenser is the universal "pump is down" signal on a
  // forecourt. This montage cuts together multiple pump angles where some
  // dispensers are bagged (out of service) and others are clear (active), so
  // the pump_bagged / pump_active Claude vision pair can count both per frame
  // and the Pump Status page can surface a live out-of-service rate.
  // ---------------------------------------------------------------------------
  {
    id: "pump-bag-montage",
    name: "Gas pump bags - out of service (montage)",
    description: "Montage of forecourt fuel dispensers, some with bags/covers tied over the nozzles (out of service) and some clear (active). Drives the pump_bagged + pump_active Claude vision pair: each bagged nozzle and each clear nozzle becomes its own bbox, and the counts feed the live out-of-service rate.",
    local: "pump-bag-montage.mp4",
    models: ["pump_bagged", "pump_active", "yolo"],
  },

  // ---------------------------------------------------------------------------
  // Bar / table-service beer fill tracking. A ceiling/table camera over guests'
  // beer glasses. Each glass is classified by how much beer is left - full,
  // half, or low - so staff can spot a guest running low and offer a refill
  // before being flagged down. The beer_full / beer_half / beer_low Claude
  // vision trio share one call per frame; the Beer Service page renders each
  // glass's fill bucket on its bbox and rolls the buckets up into an average
  // fill level and a "needs refill" count.
  // ---------------------------------------------------------------------------
  {
    id: "bar-table-montage",
    name: "Bar table - beer fill levels (montage)",
    description: "Montage of bar/restaurant tables with beer glasses at varying fill levels. Drives the beer_full + beer_half + beer_low Claude vision trio: every glass becomes its own bbox tagged with how full it is, and the counts roll up into an average fill level and a live count of glasses running low (refill candidates).",
    local: "bar-table-montage.mp4",
    models: ["beer_full", "beer_half", "beer_low", "yolo"],
  },
];

const _BY_ID = new Map<string, SampleVideo>(SAMPLE_VIDEOS.map((s) => [s.id, s]));

export function getSampleVideo(id: string): SampleVideo | undefined {
  return _BY_ID.get(id);
}

// Resolve the URL the <video> element should pull from. One endpoint for
// every flavor; the server picks local-disk vs. UC volume vs. upstream CDN
// based on the sample id. Always same-origin so canvas capture works.
export function sampleVideoUrl(sample: SampleVideo): string {
  return `/api/sample-videos/${sample.id}`;
}

// Human-friendly status string for a sample-video <video> `error` event.
//
// Probes /api/sample-videos/:id with a 1-byte Range request and inspects
// the response so the UI can surface the server's actual error body
// (the route returns JSON like `{ error: "Sample X not found locally or
// in the sample_videos volume." }` on 404) instead of every page
// repeating the same "Clip unavailable - check /api/sample-videos/<id>"
// placeholder.
//
// The 1-byte Range stays cheap on the local-disk fast path; on a 404 the
// server short-circuits before touching the UC volume or upstream CDN so
// the probe is essentially free.
export async function describeClipFailure(
  sample: SampleVideo | string | undefined,
): Promise<string> {
  const resolved = typeof sample === "string" ? getSampleVideo(sample) : sample;
  if (!resolved) {
    const id = typeof sample === "string" ? sample : "<unknown>";
    return `Clip unavailable - unknown sample id: ${id}.`;
  }
  const url = sampleVideoUrl(resolved);
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (res.ok || res.status === 206) {
      return `Clip unavailable - ${resolved.name} could not be decoded by the browser.`;
    }
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // Body wasn't JSON; fall back to status code below.
    }
    return detail
      ? `Clip unavailable - ${detail}`
      : `Clip unavailable - ${url} returned HTTP ${res.status}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Clip unavailable - ${url} unreachable: ${msg}.`;
  }
}

// Suggest the first sample that lists this model as a good fit. Returns
// undefined if none of the curated samples match - the UI then leaves the
// source dropdown alone instead of jumping to an unrelated clip.
export function defaultSampleForModel(model: ModelDefinition): SampleVideo | undefined {
  return SAMPLE_VIDEOS.find((s) => s.models.includes(model.id));
}
