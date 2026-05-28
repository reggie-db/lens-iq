// Curated catalog of sample input videos for the Live page demo.
//
// Two flavors:
//   - `upstream`: cross-origin MP4 streamed through /api/sample-videos/:id so
//     the proxy can strip CORS for canvas capture. Used for the Roboflow
//     `supervision` sample reel.
//   - `local`: file shipped under client/public/sample-videos/, served by
//     Vite in dev and by the static path in prod. Same-origin so no proxy
//     is needed. Used for the QSR / c-store / forecourt CCTV clips and the
//     spill / slip / cone safety clips downloaded for the detection demos.
//
// `models` lists the LensIQ model ids (see ./models.ts) that the sample is a
// good demo for - the UI uses this to suggest a relevant detector when the
// user picks a source.

import type { ModelDefinition } from "./models";

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
  {
    id: "vehicles",
    name: "Highway traffic",
    description: "Vehicles moving on a multi-lane highway. Great for license plate + general YOLO detection.",
    upstream: "https://media.roboflow.com/supervision/video-examples/vehicles.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "vehicles-2",
    name: "Highway traffic (alt angle)",
    description: "Second highway clip, different angle. Same use cases as the primary vehicles clip.",
    upstream: "https://media.roboflow.com/supervision/video-examples/vehicles-2.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "people-walking",
    name: "Pedestrians",
    description: "Outdoor sidewalk with multiple pedestrians walking. Ideal for people count.",
    upstream: "https://media.roboflow.com/supervision/video-examples/people-walking.mp4",
    models: ["people_count", "yolo"],
  },
  {
    id: "subway",
    name: "Subway crowd",
    description: "Dense subway crowd. Stress-tests people count and YOLO person detection.",
    upstream: "https://media.roboflow.com/supervision/video-examples/subway.mp4",
    models: ["people_count", "yolo"],
  },
  {
    id: "market-square",
    name: "Market square",
    description: "Outdoor market scene with foot traffic. Good for people count + general YOLO.",
    upstream: "https://media.roboflow.com/supervision/video-examples/market-square.mp4",
    models: ["people_count", "yolo"],
  },
  {
    id: "grocery-store",
    name: "Grocery store aisle",
    description: "Indoor retail aisle. Closest analog to a QSR/c-store interior - shoppers and products.",
    upstream: "https://media.roboflow.com/supervision/video-examples/grocery-store.mp4",
    models: ["yolo", "people_count"],
  },
  {
    id: "milk-bottling-plant",
    name: "Industrial workers",
    description: "Workers on an industrial line, often with PPE. Good for the hard hat / PPE model.",
    upstream: "https://media.roboflow.com/supervision/video-examples/milk-bottling-plant.mp4",
    models: ["hard_hat", "yolo"],
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
    description: "HD overhead CCTV inside a convenience store: aisles, customers, register area. Strong fit for yolo, people_count, cigarette_vape. Also the `clear` baseline for the fog_detector when paired with cstore-foggy-lens.",
    local: "cstore-hd-cctv.mp4",
    models: ["yolo", "people_count", "cigarette_vape", "fog_detector"],
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
    description: "Multi-angle restaurant CCTV with timestamp watermark - customers at tables and counter. Strong fit for people_count, yolo, and slip_fall as people move through the dining area.",
    local: "slip-fall-oviss.mp4",
    models: ["people_count", "slip_fall", "yolo"],
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
];

const _BY_ID = new Map<string, SampleVideo>(SAMPLE_VIDEOS.map((s) => [s.id, s]));

export function getSampleVideo(id: string): SampleVideo | undefined {
  return _BY_ID.get(id);
}

// Resolve the URL the <video> element should pull from. Local samples are
// served by the same origin (Vite dev / static dist in prod) so no proxy
// needed; cross-origin upstreams go through /api/sample-videos/:id which
// strips CORS for canvas capture.
export function sampleVideoUrl(sample: SampleVideo): string {
  if (sample.local) return `/sample-videos/${sample.local}`;
  return `/api/sample-videos/${sample.id}`;
}

// Suggest the first sample that lists this model as a good fit. Returns
// undefined if none of the curated samples match - the UI then leaves the
// source dropdown alone instead of jumping to an unrelated clip.
export function defaultSampleForModel(model: ModelDefinition): SampleVideo | undefined {
  return SAMPLE_VIDEOS.find((s) => s.models.includes(model.id));
}
