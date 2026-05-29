import { CacheManager, getExecutionContext } from "@databricks/appkit";
import { resolveServingEndpointName } from "./serving-aliases";

/** TTL (seconds) for cached serving endpoint readiness lookups. */
export const SERVING_STATUS_CACHE_TTL_SEC = 45;

export interface ServingStatus {
  alias: string;
  endpoint_name: string;
  ready: boolean;
  state: string;
  checked_at: string;
}

function _readinessFromEndpoint(endpoint: {
  state?: { ready?: string | null; config_update?: string | null } | null;
}): { ready: boolean; state: string } {
  const readyFlag = endpoint.state?.ready ?? null;
  const configUpdate = endpoint.state?.config_update ?? null;
  const ready = readyFlag === "READY";
  const state = readyFlag ?? configUpdate ?? "UNKNOWN";
  return { ready, state };
}

async function _fetchServingStatus(alias: string, endpointName: string): Promise<ServingStatus> {
  const ws = getExecutionContext().client;
  const endpoint = await ws.servingEndpoints.get({ name: endpointName });
  const { ready, state } = _readinessFromEndpoint(endpoint);
  return {
    alias,
    endpoint_name: endpointName,
    ready,
    state,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Cached Model Serving readiness for an AppKit serving alias. Uses AppKit's
 * CacheManager (in-memory or Lakebase-backed when configured on createApp).
 *
 * When `force=true` the cached entry is evicted before the lookup so the
 * caller gets a fresh read from the Workspace API. The client uses this when
 * a /api/detect call has been in flight long enough to suggest a cold start,
 * so the "Waking endpoint" overlay only fires when the endpoint is actually
 * NOT_READY (instead of guessing from response latency alone).
 */
export async function getServingStatus(
  alias: string,
  options: { force?: boolean } = {},
): Promise<ServingStatus> {
  const endpointName = resolveServingEndpointName(alias);
  if (!endpointName) {
    return {
      alias,
      endpoint_name: "",
      ready: false,
      state: "NOT_CONFIGURED",
      checked_at: new Date().toISOString(),
    };
  }

  const cache = CacheManager.getInstanceSync();
  const keyParts = ["serving-status", alias, endpointName];
  if (options.force === true) {
    await cache.delete(cache.generateKey(keyParts, "system"));
  }
  return cache.getOrExecute(
    keyParts,
    () => _fetchServingStatus(alias, endpointName),
    "system",
    { ttl: SERVING_STATUS_CACHE_TTL_SEC },
  );
}
