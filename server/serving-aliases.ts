// Centralized registry of every AppKit `serving()` alias the app uses,
// the env var the resource binding populates, and (where applicable) the
// bundle job that provisions the endpoint. Single source of truth shared
// by:
//   - serving-status.ts (readiness probe)
//   - serving-invoke.ts (generic invoke wrapper + "endpoint not deployed"
//     translation)
//   - any future feature that needs to talk about an endpoint by alias
//
// Aliases listed here MUST match:
//   - the keys in the `serving({ endpoints: { ... } })` call in server.ts
//   - resources/app.yml resource bindings
//   - app.yaml env var mappings
//   - the `servingAlias` field on client/src/lib/models.ts
//
// `deployJob` is the bundle job name (one or many tasks). Omit it for
// endpoints created out-of-band (e.g. `llm` pointing at a foundation
// model that the workspace ships pre-deployed) so the "endpoint not
// deployed" error doesn't suggest a non-existent job.

export interface ServingAliasConfig {
  /** Env var the platform populates when resources/app.yml binds the endpoint. */
  envVar: string;
  /** Human-readable name surfaced in error messages and UI hints. */
  displayName: string;
  /**
   * Bundle job that provisions the endpoint, if any. When set, an
   * "endpoint not deployed" error will tell the operator the exact
   * `databricks bundle run <job>` to fix it.
   */
  deployJob?: string;
}

export const SERVING_ALIASES: Record<string, ServingAliasConfig> = {
  llm: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_LLM",
    displayName: "LLM",
  },
  detector: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_DETECTOR",
    displayName: "YOLO general-objects detector",
    deployJob: "pizza_vision_deploy_yolo",
  },
  license_plate: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_LICENSE_PLATE",
    displayName: "License plate detector",
    deployJob: "lensiq_deploy_roboflow_detectors",
  },
  spill: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_SPILL",
    displayName: "Spill detector",
    deployJob: "lensiq_deploy_roboflow_detectors",
  },
  wet_floor_sign: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_WET_FLOOR_SIGN",
    displayName: "Wet floor sign detector",
    deployJob: "lensiq_deploy_roboflow_detectors",
  },
  cigarette_vape: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_CIGARETTE_VAPE",
    displayName: "Cigarette / vape detector",
    deployJob: "lensiq_deploy_roboflow_detectors",
  },
  slip_fall: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_SLIP_FALL",
    displayName: "Slip & fall detector",
    deployJob: "lensiq_deploy_roboflow_detectors",
  },
  fog_detector: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_FOG_DETECTOR",
    displayName: "Fog / lens-condition detector",
    deployJob: "lensiq_deploy_fog_detector",
  },
  face_recognition: {
    envVar: "DATABRICKS_SERVING_ENDPOINT_FACE_RECOGNITION",
    displayName: "Face recognition",
    deployJob: "lensiq_deploy_face_recognition",
  },
};

export function getServingAliasConfig(alias: string): ServingAliasConfig | null {
  return SERVING_ALIASES[alias] ?? null;
}

export function resolveServingEndpointName(alias: string): string | null {
  const cfg = getServingAliasConfig(alias);
  if (!cfg) return null;
  const name = process.env[cfg.envVar];
  return name && name.length > 0 ? name : null;
}
