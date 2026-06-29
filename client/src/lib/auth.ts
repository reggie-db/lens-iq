// On-behalf-of-user (OBO) availability for the current session.
//
// The Databricks Apps front-door proxy forwards the signed-in user's OAuth
// token to the app on every request once user authorization is enabled. The
// public portr tunnel (scripts/start.sh) bypasses that proxy, so no user
// token is present over the tunnel. GET /api/auth/obo (server/server.ts)
// turns that into a boolean the UI can branch on - currently used to hide
// the Genie chat button, which depends on the user token, on tunnel traffic.

import { useEffect, useState } from "react";
import { fetchJson } from "./serving-status";

interface OboResponse {
  obo: boolean;
}

/**
 * Returns whether an OBO user token reached the server for this session.
 * `undefined` while the one-shot probe is in flight so callers can avoid
 * flashing OBO-gated UI before the answer lands; resolves to `false` on any
 * fetch error (fail closed - hide the gated UI rather than render it broken).
 */
export function useOboAvailable(): boolean | undefined {
  const [obo, setObo] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchJson<OboResponse>("/api/auth/obo")
      .then((r) => {
        if (!cancelled) setObo(r.obo);
      })
      .catch(() => {
        if (!cancelled) setObo(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return obo;
}
