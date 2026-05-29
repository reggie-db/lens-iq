import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { marked } from "marked";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue, Skeleton, Slider,
} from "@databricks/appkit-ui/react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import {
  customizeTalkTrack,
  getTalkTrackState,
  resetTalkTrack,
  subscribeTalkTrack,
} from "../lib/talk-track-store";

// The /info page renders the booth talk track (docs/dais-talk-track.md)
// pulled live from /api/presenter-content/talk-track. That route reads
// from docs/ on disk in dev and falls back to the presenter_content UC
// volume in prod, so the script can be edited and re-synced without a
// full redeploy.
//
// On top of the raw markdown the page exposes three controls - speaker
// persona, audience persona, and target read time - that ship to the
// foundation-model rewrite route (POST /api/talk-track/transform).
//
// The rewrite is driven through the module-level talk-track-store so
// the request survives page navigation. Clicking "Customize" fires a
// background request, surfaces a sonner toast, and (when the user is
// still on /info) updates the page in place when the result lands. If
// the presenter wanders off to /spills mid-rewrite, the toast still
// fires when it's done and the result is waiting in the store when
// they come back.
//
// The default state is the full original markdown; a "Reset to full"
// button (or the store's `idle` state on first mount) reverts.
//
// The booth deck (HTML slides) lives at its own /deck route - see
// pages/Deck.tsx - to give it the full viewport.

marked.setOptions({ gfm: true, breaks: false });

// Curated personas the rewrite prompt knows how to handle well. Both
// dropdowns are free-form on the server side (the prompt accepts any
// string), but constraining the UI to a known catalogue keeps the
// booth presenter's choices crisp.
const SPEAKER_PERSONAS = [
  "Solutions Architect",
  "Account Executive",
  "Field Engineer",
  "Customer Engineer",
  "Executive Briefing Lead",
] as const;

const AUDIENCE_PERSONAS = [
  "Chief Financial Officer (CFO)",
  "Chief Technology Officer (CTO)",
  "Chief Information Officer (CIO)",
  "VP of Operations",
  "VP of Loss Prevention",
  "Chief Marketing Officer (CMO)",
  "Restaurant / Store Manager",
  "IT Director",
  "Data Engineer / Architect",
] as const;

const DEFAULT_SPEAKER: string = SPEAKER_PERSONAS[0];
const DEFAULT_AUDIENCE: string = AUDIENCE_PERSONAS[0];
const DEFAULT_LENGTH = 5;
const MIN_LENGTH = 1;
const MAX_LENGTH = 10;

export function InfoPage() {
  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // External store for the rewrite. Lives at module scope so the LLM
  // call keeps running across /info -> /spills -> /info navigation.
  const rewrite = useSyncExternalStore(subscribeTalkTrack, getTalkTrackState);

  // Persona + length controls. Default-initialised from whatever the
  // store last applied, so navigating back to /info shows the same
  // controls that produced the rewrite currently on screen. The store
  // is the source of truth for the rewrite; these are just inputs to
  // the next customize call.
  const [speakerPersona, setSpeakerPersona] = useState<string>(
    rewrite.appliedOpts?.speakerPersona ?? rewrite.pending?.speakerPersona ?? DEFAULT_SPEAKER,
  );
  const [audiencePersona, setAudiencePersona] = useState<string>(
    rewrite.appliedOpts?.audiencePersona ?? rewrite.pending?.audiencePersona ?? DEFAULT_AUDIENCE,
  );
  const [lengthMinutes, setLengthMinutes] = useState<number>(
    rewrite.appliedOpts?.lengthMinutes ?? rewrite.pending?.lengthMinutes ?? DEFAULT_LENGTH,
  );

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

  const handleCustomize = () => {
    customizeTalkTrack({ speakerPersona, audiencePersona, lengthMinutes });
  };

  const handleReset = () => {
    resetTalkTrack();
  };

  // The markdown actually rendered: the store's current rewrite when
  // it's ready, otherwise the full original. Memoised so we don't
  // reparse on every unrelated state update (slider drag, etc.).
  const displayedMarkdown = rewrite.status === "ready" && rewrite.markdown
    ? rewrite.markdown
    : markdown;
  const html = useMemo(
    () => marked.parse(displayedMarkdown) as string,
    [displayedMarkdown],
  );

  const isRewriting = rewrite.status === "loading";
  const pendingLabel = rewrite.pending
    ? `${rewrite.pending.speakerPersona} -> ${rewrite.pending.audiencePersona}, ${rewrite.pending.lengthMinutes} min`
    : null;
  const appliedLabel = rewrite.appliedOpts
    ? `${rewrite.appliedOpts.speakerPersona} -> ${rewrite.appliedOpts.audiencePersona}, ${rewrite.appliedOpts.lengthMinutes} min`
    : null;

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-lava-600" />
            <span>Tune the talk track</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">
            Pick a speaker, an audience, and a target read time. The full
            talk track is rewritten by a Databricks foundation model on
            the <code className="text-xs">llm</code> serving endpoint and
            cached server-side by content hash. The rewrite runs in the
            background - feel free to navigate around the app while it
            finishes. The default view below is the original markdown.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="speaker-persona" className="text-xs text-slate-600">
                Speaker
              </Label>
              <Select value={speakerPersona} onValueChange={setSpeakerPersona}>
                <SelectTrigger id="speaker-persona" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Speaker persona</SelectLabel>
                    {SPEAKER_PERSONAS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audience-persona" className="text-xs text-slate-600">
                Audience
              </Label>
              <Select value={audiencePersona} onValueChange={setAudiencePersona}>
                <SelectTrigger id="audience-persona" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Audience persona</SelectLabel>
                    {AUDIENCE_PERSONAS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="length-minutes" className="text-xs text-slate-600">
                  Target read time
                </Label>
                <span className="text-xs font-mono tabular-nums text-slate-700">
                  {lengthMinutes} min
                </span>
              </div>
              <Slider
                id="length-minutes"
                min={MIN_LENGTH}
                max={MAX_LENGTH}
                step={1}
                value={[lengthMinutes]}
                onValueChange={(v) => setLengthMinutes(v[0] ?? lengthMinutes)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={handleCustomize}
              disabled={!markdown}
              className="gap-1.5"
            >
              {isRewriting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {isRewriting ? "Rewriting..." : "Customize talk track"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={rewrite.status === "idle"}
              className="gap-1.5"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to full
            </Button>

            {isRewriting && pendingLabel && (
              <Badge variant="outline" className="gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Rewriting: {pendingLabel}</span>
              </Badge>
            )}
            {!isRewriting && rewrite.status === "ready" && appliedLabel && (
              <Badge variant="outline" className="gap-1">
                <span>{appliedLabel}</span>
                {rewrite.cached && <span className="text-slate-500">(cached)</span>}
              </Badge>
            )}
            {rewrite.status === "idle" && !isRewriting && (
              <Badge variant="outline">Showing full original</Badge>
            )}
          </div>

          {rewrite.status === "error" && rewrite.error && (
            <div className="text-sm text-red-600">
              Rewrite failed: {rewrite.error}
            </div>
          )}
        </CardContent>
      </Card>

      {loading && !markdown && <Skeleton className="h-96 w-full" />}
      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-red-600">
            Failed to load talk track: {error}
          </CardContent>
        </Card>
      )}
      {/* While a rewrite is in flight we hide the article body entirely
          (rather than letting the user read a stale version that's
          about to be replaced) and render a skeleton + status line
          instead. The toast + persona pill above still tell them what's
          happening, and the rewrite keeps running even if they leave
          this page. */}
      {isRewriting ? (
        <Card>
          <CardContent className="py-6 space-y-3">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>
                Rewriting the talk track{pendingLabel ? ` for ${pendingLabel}` : ""}.
                You can navigate to other pages while this finishes.
              </span>
            </div>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      ) : (
        displayedMarkdown && (
          <article
            className="talk-track prose prose-slate max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )
      )}
    </div>
  );
}
