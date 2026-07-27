// On-behalf-of-user (OBO) availability for the current session.
//
// The Databricks Apps front-door proxy forwards the signed-in user's OAuth
// token to the app on every request once user authorization is enabled.
// GET /api/auth/obo (server/server.ts) turns that into a boolean the UI can
// branch on - currently used to hide the Genie chat button when the user
// token is absent. In local/dev (NODE_ENV !== production) the server always
// reports true so Genie stays visible while testing.

import { useEffect, useState } from "react";
import { fetchJson } from "./serving-status";

interface OboResponse {
  obo: boolean;
}

/**
 * Returns whether an OBO user token reached the server for this session.
 *
 * `undefined` while the probe is in flight - callers should treat that as
 * flashing OBO-gated UI before the answer lands; resolves to `false` on any
 * network / parse failure so the chat stays hidden rather than breaking.
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
