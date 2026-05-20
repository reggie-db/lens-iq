// Shared registry of all object-detection models exposed by the app.
//
// Every model is served through Databricks Model Serving via the AppKit
// `serving()` plugin. Two endpoint aliases exist:
//
//   - "detector":          single-model YOLO PyFunc (general objects). Defined
//                          by notebooks/deploy_yolo.ipynb.
//   - "roboflow_detector": multi-model Roboflow PyFunc that dispatches by
//                          `model_id`. Defined by
//                          notebooks/deploy_roboflow_models.ipynb. A single
//                          endpoint hosts every Roboflow Universe model.
//
// `roboflowModelId` (when present) is passed as the `model_id` row column to
// the multi-model endpoint so it picks the right submodel. `color` drives the
// bounding-box overlay and chart tinting on the Live page.

export type ModelProvider = "databricks";

export interface ModelDefinition {
  id: string;
  name: string;
  description: string;
  provider: ModelProvider;
  color: string;
  servingAlias: string;
  // Only set when `servingAlias === "roboflow_detector"`. Identifies which
  // Roboflow Universe model the multi-model endpoint should dispatch to.
  roboflowModelId?: string;
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
    servingAlias: "roboflow_detector",
    roboflowModelId: "roboflow-universe-projects/license-plate-recognition-rxg4e/13",
    color: "#0ea5e9",
  },
  {
    id: "spill",
    name: "Spills",
    description: "Detects liquid spills on store floors and forecourts. Pair with the wet-floor sign model to confirm signage.",
    provider: "databricks",
    servingAlias: "roboflow_detector",
    roboflowModelId: "cv-6rgre/spills-ax5xv/2",
    color: "#eab308",
  },
  {
    id: "wet_floor_sign",
    name: "Wet floor sign",
    description: "Detects wet-floor caution signs. Pair with the spill model to validate that signage is deployed.",
    provider: "databricks",
    servingAlias: "roboflow_detector",
    roboflowModelId: "june-2023-wet-floor-sign/wet-floor-sign2/1",
    color: "#f97316",
  },
  {
    id: "cigarette_vape",
    name: "Cigarette / vape",
    description: "Loss-prevention model. Detects cigarettes and vapes around c-store age-gated areas.",
    provider: "databricks",
    servingAlias: "roboflow_detector",
    roboflowModelId: "takoyati/cigarette-vape-detection/14",
    color: "#a855f7",
  },
  {
    id: "slip_fall",
    name: "Slip & fall",
    description: "Detects standing vs fallen persons. Pair with the spill model for incident response.",
    provider: "databricks",
    servingAlias: "roboflow_detector",
    roboflowModelId: "sensormatic/slip-and-fall/2",
    color: "#10b981",
  },
];

export const DEFAULT_MODEL_ID = "yolo";

export function getModel(id: string): ModelDefinition | undefined {
  return MODELS.find((m) => m.id === id);
}
