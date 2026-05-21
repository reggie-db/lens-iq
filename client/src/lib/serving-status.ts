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
