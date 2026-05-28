import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { Card, CardContent, Skeleton } from "@databricks/appkit-ui/react";

// The /info page renders the booth talk track (docs/dais-talk-track.md)
// pulled live from /api/presenter-content/talk-track. That route reads
// from docs/ on disk in dev and falls back to the presenter_content UC
// volume in prod, so the script can be edited and re-synced without a
// full redeploy.
//
// The content is fetched once on mount with Cache-Control: no-store so
// a browser refresh always pulls the latest copy from the volume - no
// in-app refresh button needed.
//
// The booth deck (HTML slides) lives at its own /deck route — see
// pages/Deck.tsx — to give it the full viewport.
//
// GFM gives us the few markdown bits the talk track relies on (lists,
// fenced code, autolinks). Configured once at module load.
marked.setOptions({ gfm: true, breaks: false });

export function InfoPage() {
  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/presenter-content/talk-track", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Talk track fetch failed: HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setMarkdown(text);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const html = useMemo(() => marked.parse(markdown) as string, [markdown]);

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-4">
      {loading && !markdown && <Skeleton className="h-96 w-full" />}
      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-red-600">
            Failed to load talk track: {error}
          </CardContent>
        </Card>
      )}
      {markdown && (
        <article
          className="talk-track prose prose-slate max-w-none"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
