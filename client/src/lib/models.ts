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
//   spill             | spill              | lensiq-spill
//   wet_floor_sign    | wet_floor_sign     | lensiq-wet-floor-sign
//   cigarette_vape    | cigarette_vape     | lensiq-cigarette-vape
//   slip_fall         | slip_fall          | lensiq-slip-fall
//   fog_detector      | fog_detector       | lensiq-fog-detector
//
// `servingAlias` is the key registered with `serving()` in server/server.ts
// and bound to a real endpoint in resources/app.yml. There is no dispatch
// layer: the client sends `model_id` to the server, the server maps it to
// `model.servingAlias` and invokes that endpoint directly.
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
    description: "Detects liquid spills on store floors and forecourts. Pair with the wet-floor sign model to confirm signage.",
    provider: "databricks",
    servingAlias: "spill",
    color: "#eab308",
  },
  {
    id: "wet_floor_sign",
    name: "Wet floor sign",
    description: "Detects wet-floor caution signs. Pair with the spill model to validate that signage is deployed.",
    provider: "databricks",
    servingAlias: "wet_floor_sign",
    color: "#f97316",
  },
  {
    id: "cigarette_vape",
    name: "Cigarette / vape",
    description: "Loss-prevention model. Detects cigarettes and vapes around c-store age-gated areas.",
    provider: "databricks",
    servingAlias: "cigarette_vape",
    color: "#a855f7",
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
