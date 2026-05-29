import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Label, Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue, Skeleton, Slider,
} from "@databricks/appkit-ui/react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { fetchJson } from "../lib/serving-status";

// The /info page renders the booth talk track (docs/dais-talk-track.md)
// pulled live from /api/presenter-content/talk-track. That route reads
// from docs/ on disk in dev and falls back to the presenter_content UC
// volume in prod, so the script can be edited and re-synced without a
// full redeploy.
//
// On top of the raw markdown the page exposes three controls - speaker
// persona, audience persona, and target read time - that ship to the
// foundation-model rewrite route (POST /api/talk-track/transform).
// That route is backed by the `llm` serving alias and caches by
// (source content hash, persona tuple) for an hour. The default state
// is the full original markdown; the rewritten version is only shown
// after the presenter explicitly clicks "Customize", and a "Reset to
// full" button reverts to the original.
//
// A small in-memory cache here (keyed by the same persona tuple as the
// server cache) keeps clicking back and forth between persona settings
// snappy without re-hitting the network.
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

interface TransformResponse {
  markdown: string;
  cached: boolean;
}

function _cacheKey(speaker: string, audience: string, length: number): string {
  return `${speaker}|${audience}|${length}`;
}

export function InfoPage() {
  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Persona + length controls. They start at sensible defaults but the
  // page still shows the full original markdown until the presenter
  // clicks "Customize".
  const [speakerPersona, setSpeakerPersona] = useState<string>(DEFAULT_SPEAKER);
  const [audiencePersona, setAudiencePersona] = useState<string>(DEFAULT_AUDIENCE);
  const [lengthMinutes, setLengthMinutes] = useState<number>(DEFAULT_LENGTH);

  // Rewrite state. customMarkdown null = show the original; non-null
  // means we've fetched at least once and are showing that result.
  const [customMarkdown, setCustomMarkdown] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [customCached, setCustomCached] = useState<boolean>(false);
  const [customLoading, setCustomLoading] = useState<boolean>(false);
  const [customError, setCustomError] = useState<string | null>(null);

  // Client-side rewrite cache. Keyed by (speaker, audience, length).
  // The server caches too; this layer keeps re-selecting a previous
  // combination from being a network round-trip.
  const cacheRef = useRef<Map<string, string>>(new Map());

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

  const handleCustomize = useCallback(async () => {
    setCustomError(null);
    const key = _cacheKey(speakerPersona, audiencePersona, lengthMinutes);
    const hit = cacheRef.current.get(key);
    if (hit) {
      setCustomMarkdown(hit);
      setCustomLabel(`${speakerPersona} -> ${audiencePersona}, ${lengthMinutes} min`);
      setCustomCached(true);
      return;
    }
    setCustomLoading(true);
    try {
      const res = await fetchJson<TransformResponse>("/api/talk-track/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerPersona, audiencePersona, lengthMinutes }),
      });
      cacheRef.current.set(key, res.markdown);
      setCustomMarkdown(res.markdown);
      setCustomLabel(`${speakerPersona} -> ${audiencePersona}, ${lengthMinutes} min`);
      setCustomCached(res.cached);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomLoading(false);
    }
  }, [speakerPersona, audiencePersona, lengthMinutes]);

  const handleReset = useCallback(() => {
    setCustomMarkdown(null);
    setCustomLabel(null);
    setCustomCached(false);
    setCustomError(null);
  }, []);

  // The markdown actually rendered: the custom rewrite if we have one,
  // otherwise the full original. Memoised so we don't reparse on every
  // unrelated state update (persona changes, etc.).
  const displayedMarkdown = customMarkdown ?? markdown;
  const html = useMemo(() => marked.parse(displayedMarkdown) as string, [displayedMarkdown]);

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
            cached server-side by content hash. The default view below is
            the original, unedited markdown.
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
              onClick={() => void handleCustomize()}
              disabled={customLoading || !markdown}
              className="gap-1.5"
            >
              {customLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {customLoading ? "Rewriting..." : "Customize talk track"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={customMarkdown == null || customLoading}
              className="gap-1.5"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to full
            </Button>

            {customLabel && (
              <Badge variant="outline" className="gap-1">
                <span>{customLabel}</span>
                {customCached && <span className="text-slate-500">(cached)</span>}
              </Badge>
            )}
            {customMarkdown == null && !customLoading && (
              <Badge variant="outline">Showing full original</Badge>
            )}
          </div>

          {customError && (
            <div className="text-sm text-red-600">
              Rewrite failed: {customError}
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
      {displayedMarkdown && (
        <article
          className="talk-track prose prose-slate max-w-none"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
