// Shared registry of all object-detection models exposed by the app.
//
// Every model is served through Databricks Model Serving via the AppKit
// `serving()` plugin. Each use case has its own dedicated endpoint and its
// own UC registered model so versioning, ownership, scale-to-zero, and
// cost attribution are independent per detector:
//
//   id                | servingAlias       | endpoint name (default)
//   ------------------|--------------------|---------------------------
//   yolo              | detector           | lensiq-detector
//   license_plate     | license_plate      | lensiq-license-plate
//   spill             | llm                | databricks-claude-* (foundation)
//   wet_floor_sign    | llm                | databricks-claude-* (foundation)
//   pizza_inventory   | llm                | databricks-claude-* (foundation)
//   pizza_pie         | llm                | databricks-claude-* (foundation)
//   pump_bagged       | llm                | databricks-claude-* (foundation)
//   pump_active       | llm                | databricks-claude-* (foundation)
//   beer_full         | llm                | databricks-claude-* (foundation)
//   beer_half         | llm                | databricks-claude-* (foundation)
//   beer_low          | llm                | databricks-claude-* (foundation)
//   slip_fall         | slip_fall          | lensiq-slip-fall
//   fog_detector      | fog_detector       | lensiq-fog-detector
//
// `servingAlias` is the key registered with `serving()` in server/server.ts
// and bound to a real endpoint in resources/app.yml. There is no dispatch
// layer: the client sends `model_id` to the server, the server maps it to
// `model.servingAlias` and invokes that endpoint directly.
//
// Spill + wet-floor-sign are the exception: off-the-shelf Roboflow
// models miss the subtle wet patches and miscellaneous caution cones
// you actually see in supermarket CCTV (see server/vision-detector.ts
// for the story). Both short-circuit /api/detect through one Claude
// vision call on the shared `llm` alias, with the second call per
// frame served from an image-hash cache so two-class detection costs
// one LLM round-trip per frame.
//
// `color` drives the bounding-box overlay and chart tinting on the Live
// page.

export type ModelProvider = "databricks";

export interface ModelDefinition {
  id: string;
  name: string;
  description: string;
  provider: ModelProvider;
  color: string;
  servingAlias: string;
}

export const MODELS: ModelDefinition[] = [
  {
    id: "yolo",
    name: "YOLO (general objects)",
    description: "Custom YOLOv8 served via Databricks Model Serving. Detects pizza, vehicles, people, trucks.",
    provider: "databricks",
    servingAlias: "detector",
    color: "#dc2626",
  },
  {
    id: "license_plate",
    name: "License plates",
    description: "Detects vehicle license plates. Useful for drive-through plate capture and forecourt analytics.",
    provider: "databricks",
    servingAlias: "license_plate",
    color: "#0ea5e9",
  },
  {
    id: "spill",
    name: "Spills",
    description: "Detects liquid spills on store floors and forecourts using a Databricks-hosted Claude vision model. Pair with the wet-floor sign model to confirm signage.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#eab308",
  },
  {
    id: "wet_floor_sign",
    name: "Wet floor sign",
    description: "Detects wet-floor caution cones using the same Databricks-hosted Claude vision call as the spill detector. Pair with the spill model to validate that signage is deployed.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#f97316",
  },
  // Pizza Inventory pair. Both models go through one Claude vision call
  // per frame (same labels + prompt -> image-hash cache hit on the
  // second /api/detect). The Pizza Inventory page calls both in
  // parallel each tick so the operator sees "X slices available" and
  // "Y whole pies staged" from a single round-trip. See
  // server/server.ts VISION_GROUPS for the shared prompt and
  // ./samples.ts -> "Pizza slice inventory" for the canonical clip.
  {
    id: "pizza_inventory",
    name: "Pizza slice inventory",
    description: "Counts available pizza slices on the counter via a Databricks-hosted Claude vision call. Each detected slice gets its own bounding box; the total count is the slice inventory feeding hot-hold restock alerts.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#b91c1c",
  },
  {
    id: "pizza_pie",
    name: "Whole pizzas",
    description: "Counts complete uncut pizzas currently staged using the same Databricks-hosted Claude vision call as the slice counter. Paired with pizza_inventory to give an operator both `slices ready` and `pies staged` counts from one round-trip.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#f59e0b",
  },
  // Gas-station pump out-of-service pair. A bag/cover tied over a fuel
  // nozzle is the universal "pump down" signal on a forecourt. Both models
  // go through one Claude vision call per frame (identical labels + prompt
  // -> image-hash cache hit on the second /api/detect). The Pump Status
  // page calls both in parallel each tick so the operator sees how many
  // dispensers are bagged (out of service) vs clear (active) and the live
  // out-of-service rate. See server/server.ts VISION_GROUPS for the shared
  // prompt and ./samples.ts -> "pump-bag-montage" for the canonical clip.
  {
    id: "pump_bagged",
    name: "Bagged pumps (out of service)",
    description: "Detects fuel dispensers with a bag or cover tied over the nozzle - the standard out-of-service marker on a gas-station forecourt - via a Databricks-hosted Claude vision call. Each bagged pump gets its own bounding box; the count is the out-of-service dispenser total.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#dc2626",
  },
  {
    id: "pump_active",
    name: "Active pumps",
    description: "Counts fuel dispensers whose nozzles are clear and in service using the same Databricks-hosted Claude vision call as the bagged-pump detector. Paired with pump_bagged to give an operator both `out of service` and `active` dispenser counts - and the out-of-service rate - from one round-trip.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#16a34a",
  },
  // Bar / table-service beer fill-level trio. A camera over guests' beer
  // glasses classifies each glass by how much beer is left so staff can
  // offer a refill before a guest has to flag someone down. All three
  // models go through one Claude vision call per frame (identical labels +
  // prompt -> image-hash / perceptual cache hit on the 2nd and 3rd
  // /api/detect). The Beer Service page calls all three in parallel each
  // tick: each glass's fill bucket renders on its bbox, and the buckets roll
  // up into an average fill level plus a "running low" refill count. See
  // server/server.ts VISION_GROUPS for the shared prompt and ./samples.ts ->
  // "bar-table-montage" for the canonical clip.
  {
    id: "beer_full",
    name: "Full beers",
    description: "Detects beer glasses that are mostly to completely full (roughly two-thirds or more) via a Databricks-hosted Claude vision call. Each full glass gets its own bounding box; paired with beer_half and beer_low to classify every glass on the table by fill level.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#16a34a",
  },
  {
    id: "beer_half",
    name: "Half beers",
    description: "Counts beer glasses that are roughly half full (about one-third to two-thirds) using the same Databricks-hosted Claude vision call as the other beer fill detectors. The middle bucket between beer_full and beer_low.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#f59e0b",
  },
  {
    id: "beer_low",
    name: "Low beers (refill soon)",
    description: "Detects beer glasses running low or nearly empty (under about one-third) using the same Databricks-hosted Claude vision call as the other beer fill detectors. These are the refill candidates the Beer Service page counts so staff can offer another round.",
    provider: "databricks",
    servingAlias: "llm",
    color: "#dc2626",
  },
  {
    id: "slip_fall",
    name: "Slip & fall",
    description: "Detects standing vs fallen persons. Pair with the spill model for incident response.",
    provider: "databricks",
    servingAlias: "slip_fall",
    color: "#10b981",
  },
  // Camera-health classifier. Standalone Pillow+numpy PyFunc (no external
  // API) that flags fogged / contaminated lenses and returns localized
  // bboxes around affected regions. Deployed by
  // notebooks/deploy_fog_detector.ipynb.
  {
    id: "fog_detector",
    name: "Camera fog / lens condition",
    description: "Diagnostic classifier that flags fogged or contaminated camera lenses. Use it to monitor camera health on freezer/cooler aisles, dome cameras with condensation, or outdoor PTZ cameras after rain.",
    provider: "databricks",
    servingAlias: "fog_detector",
    color: "#06b6d4",
  },
];

export const DEFAULT_MODEL_ID = "yolo";

export function getModel(id: string): ModelDefinition | undefined {
  return MODELS.find((m) => m.id === id);
}
