// Generic wrapper around `appkit.serving(alias).invoke(payload)` that:
//   1. Normalizes the two failure modes (thrown error vs `{ok:false}`
//      envelope) into a single throw path.
//   2. Detects the "endpoint isn't deployed yet" family of errors that
//      come back from Model Serving when an alias points at an endpoint
//      name that doesn't exist (or got deleted, or the resource binding
//      hasn't propagated yet). Translates those into a typed
//      `EndpointNotDeployedError` carrying the alias, friendly display
//      name, and the bundle job that provisions it, so any route can
//      respond with the same structured payload without re-implementing
//      the heuristic.
//   3. Lets every other error pass through with the original message so
//      existing per-route error formatting (e.g. "Detector failed (yolo):
//      ...") keeps working.
//
// All callers should funnel `appkit.serving(...).invoke(...)` calls through
// `invokeServing()` so that operator UX around "the endpoint isn't up"
// is consistent across detectors, LLM OCR, face recognition, and any
// future feature.

import type { Response } from "express";
import { getServingAliasConfig } from "./serving-aliases";

/** Shape every `appkit.serving(alias).invoke(...)` call returns. */
export interface ServingInvokeResult {
  ok: boolean;
  data?: unknown;
  status?: number;
  message?: string;
}

/**
 * Minimal duck-typed accessor; matches `appkit.serving(alias).invoke(...)`
 * from AppKit. `payload` is `Record<string, unknown>` because AppKit's
 * generated `invoke()` signature requires a plain JSON object - aligning
 * here lets every alias (whose registry-typed `request` shape extends
 * `Record<string, unknown>`) pass through without per-call casts.
 */
export interface ServingClient {
  serving: (alias: string) => {
    invoke: (payload: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * Thrown when the underlying serving alias points at an endpoint that
 * doesn't exist yet. Routes can `instanceof` check this and respond
 * with a structured "deploy this job" hint instead of a generic 502.
 */
export class EndpointNotDeployedError extends Error {
  readonly alias: string;
  readonly displayName: string;
  readonly deployJob: string | null;
  readonly originalMessage: string;

  constructor(alias: string, displayName: string, deployJob: string | null, originalMessage: string) {
    const friendly = deployJob
      ? `${displayName} endpoint is not deployed yet. Run \`databricks bundle run ${deployJob}\` and try again.`
      : `${displayName} endpoint is not deployed yet. Check the endpoint name and resource binding.`;
    super(friendly);
    this.name = "EndpointNotDeployedError";
    this.alias = alias;
    this.displayName = displayName;
    this.deployJob = deployJob;
    this.originalMessage = originalMessage;
  }
}

// Patterns the Workspace Serving API uses when an endpoint name is
// unknown. Match conservatively (lowercase + substring) so a renamed
// error code in a future SDK release still trips the same branch.
const NOT_DEPLOYED_PATTERNS = [
  "does not exist",
  "resource_does_not_exist",
  "could not find serving endpoint",
  "endpoint not found",
  "no such serving endpoint",
];

function _isNotDeployedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return NOT_DEPLOYED_PATTERNS.some((p) => lower.includes(p));
}

function _classify(alias: string, message: string): Error {
  if (!_isNotDeployedMessage(message)) return new Error(message);
  const cfg = getServingAliasConfig(alias);
  const displayName = cfg?.displayName ?? alias;
  const deployJob = cfg?.deployJob ?? null;
  return new EndpointNotDeployedError(alias, displayName, deployJob, message);
}

/**
 * Invoke a serving alias and either return `result.data` on success or
 * throw a classified error. Use this in place of raw
 * `appkit.serving(alias).invoke(payload)` so endpoint-not-deployed
 * errors are translated uniformly across the app.
 */
export async function invokeServing(
  appkit: ServingClient,
  alias: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  let result: ServingInvokeResult;
  try {
    result = (await appkit.serving(alias).invoke(payload)) as ServingInvokeResult;
  } catch (err) {
    throw _classify(alias, err instanceof Error ? err.message : String(err));
  }
  if (!result.ok) {
    const message = result.message ?? `Serving alias '${alias}' invoke failed`;
    throw _classify(alias, message);
  }
  return result.data;
}

/**
 * Express helper: turn an error from `invokeServing` (or any descendant
 * of it) into a JSON response with consistent shape. Returns true if it
 * handled the error so the caller can short-circuit; false if it was a
 * generic error the caller should format itself.
 *
 * The structured payload lets clients branch on `code` instead of
 * regex-matching the human-readable message:
 *   { error, code: "endpoint_not_deployed", alias, display_name, deploy_job }
 */
export function sendEndpointError(res: Response, err: unknown): boolean {
  if (err instanceof EndpointNotDeployedError) {
    res.status(503).json({
      error: err.message,
      code: "endpoint_not_deployed",
      alias: err.alias,
      display_name: err.displayName,
      deploy_job: err.deployJob,
    });
    return true;
  }
  return false;
}
