// Cached Model Serving readiness from GET /api/serving-status/:alias.

export interface ServingStatus {
  alias: string;
  endpoint_name: string;
  ready: boolean;
  state: string;
  checked_at: string;
}

export async function fetchServingStatus(
  alias: string,
  options: { force?: boolean } = {},
): Promise<ServingStatus> {
  const qs = options.force ? "?force=1" : "";
  const res = await fetch(`/api/serving-status/${encodeURIComponent(alias)}${qs}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Serving status failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<ServingStatus>;
}

// ─── Endpoint-not-deployed error envelope ────────────────────────────────
//
// Any server route that calls `invokeServing(...)` and pipes the failure
// through `sendEndpointError(res, err)` will respond with this shape when
// the alias points at an endpoint that hasn't been provisioned yet:
//
//   503 { error, code: "endpoint_not_deployed",
//         alias, display_name, deploy_job }
//
// Frontends should branch on `code` (not the human-readable message) so
// the UI keeps working even if the error string changes.

export interface EndpointNotDeployedResponse {
  error: string;
  code: "endpoint_not_deployed";
  alias: string;
  display_name: string;
  deploy_job: string | null;
}

export function isEndpointNotDeployed(
  body: unknown,
): body is EndpointNotDeployedResponse {
  if (!body || typeof body !== "object") return false;
  const obj = body as { code?: unknown };
  return obj.code === "endpoint_not_deployed";
}

/**
 * Typed error class thrown by `fetchJson` when the server replies with
 * the endpoint-not-deployed envelope. Pages can `instanceof` check this
 * to render a deploy banner instead of toasting a raw error message.
 */
export class EndpointNotDeployedError extends Error {
  readonly alias: string;
  readonly displayName: string;
  readonly deployJob: string | null;

  constructor(body: EndpointNotDeployedResponse) {
    super(body.error);
    this.name = "EndpointNotDeployedError";
    this.alias = body.alias;
    this.displayName = body.display_name;
    this.deployJob = body.deploy_job;
  }
}

/**
 * Thin JSON-aware `fetch` wrapper that:
 *   - Parses the body as JSON when possible.
 *   - On non-2xx, throws `EndpointNotDeployedError` for the structured
 *     503 from serving-invoke.ts, or a plain `Error(body.error)` for any
 *     other server-side `{error: string}` payload.
 *
 * Use this anywhere the client posts to a route that funnels through
 * `invokeServing()` so the deploy-banner UX works without copy/pasted
 * regex matches on the error message.
 */
export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    if (isEndpointNotDeployed(body)) throw new EndpointNotDeployedError(body);
    const message = body && typeof body === "object" && "error" in body
      && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : typeof body === "string" && body.length > 0
        ? body
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}
