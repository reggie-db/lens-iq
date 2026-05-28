import { useMemo } from "react";
import { marked } from "marked";
import { Badge, Card, CardContent } from "@databricks/appkit-ui/react";
import { BookOpen } from "lucide-react";

// The /info page renders docs/dais-talk-track.md verbatim so the booth
// presenter, the AE running through the demo, and the repo PR reviewer are
// all reading the exact same words. The markdown file is the single source
// of truth - imported at build time via Vite's ?raw suffix.
import talkTrackMd from "../../../docs/dais-talk-track.md?raw";

// Configure once at module load. GFM gives us the bits the talk track uses
// (lists, fenced code, autolinks). Headings render as plain <h1>..<hN> and
// pick up the prose styling below.
marked.setOptions({ gfm: true, breaks: false });

export function InfoPage() {
  const html = useMemo(() => marked.parse(talkTrackMd) as string, []);

  return (
    <div className="max-w-4xl mx-auto pb-12">
      <Card className="mb-6">
        <CardContent className="flex items-center gap-3 py-4">
          <BookOpen className="w-5 h-5 text-red-600 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-900">
              Booth talk track
            </div>
            <div className="text-xs text-slate-600">
              Rendered live from <code className="text-xs">docs/dais-talk-track.md</code>.
              Edit the markdown to update this page.
            </div>
          </div>
          <Badge variant="outline">5-10 min</Badge>
        </CardContent>
      </Card>

      <article
        className="talk-track prose prose-slate max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
