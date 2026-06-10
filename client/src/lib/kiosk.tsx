import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MousePointer2, X } from "lucide-react";

// Kiosk mode: a hands-free "demo driver" for an unattended booth screen.
//
// It is intentionally NOT the guided tour (see lib/tour.tsx). The tour gives
// the presenter tips to read aloud; the kiosk just *pokes around the app
// showing visuals* so a passer-by sees the screen moving on its own. Each
// stop runs the same little movie:
//
//   move  -> a fake cursor glides to the matching sidebar nav item
//   click -> a click ripple fires and we navigate to that page
//   look  -> the relevant section gets a glowing highlight + a caption
//            drawn from the DAIS talk track (docs/dais-talk-track.md)
//
// then it advances to the next stop and loops forever. It is fully
// non-modal: the overlay never blocks the page, the simulated clicks are
// programmatic navigate() calls (never synthetic pointer events), and any
// *real* tap/click into the app pauses the loop so a visitor can take over.
// After KIOSK_INACTIVITY_RESUME_MS of no interaction the loop resumes.

// Phase timings. Total per stop ~= MOVE + CLICK + DWELL.
const MOVE_MS = 1500;
const CLICK_MS = 900;
const DWELL_MS = 8400;
// Resume the loop this long after the last real user interaction.
const KIOSK_INACTIVITY_RESUME_MS = 30000;
// Target-resolution polling (the page may still be mounting after navigate()).
const TARGET_LOOKUP_INTERVAL_MS = 80;
const TARGET_LOOKUP_TIMEOUT_MS = 2500;

type Phase = "move" | "click" | "look";

interface KioskStop {
  /** Route view slug (matches data-nav on the sidebar button and the path). */
  view: string;
  /** CSS selector for the section to highlight once the page renders. */
  target: string;
  /** Short headline shown in the caption banner. */
  title: string;
  /** One-line narration drawn from the talk track. */
  caption: string;
}

// Stops mirror Section 3 of docs/dais-talk-track.md, in the order a presenter
// would walk the booth. Targets reuse existing data-tour anchors where they
// exist and dedicated data-kiosk anchors added to the stat sections otherwise.
const KIOSK_STOPS: KioskStop[] = [
  {
    view: "live",
    target: '[data-tour="live-video"]',
    title: "Live Detection",
    caption:
      "The footage your stores already record - every frame scored by a model right now. Each use case is its own serving endpoint that scales to zero.",
  },
  {
    view: "spills",
    target: '[data-kiosk="spill-response"]',
    title: "Spill Detection",
    caption:
      "Spill at second one, cone at second 27. Time-to-cone becomes a number on a dashboard, read straight out of Lakebase.",
  },
  {
    view: "plates",
    target: '[data-kiosk="plates-recent"]',
    title: "License Plates",
    caption:
      "YOLO finds the vehicle, Claude vision reads the plate. One read per visit - drive-off, drive-thru SLA, and loyalty off the same row.",
  },
  {
    view: "guests",
    target: '[data-kiosk="guest-counts"]',
    title: "Guest Counts",
    caption:
      "Forecourt, pumps, and c-store counted in parallel as unique tracks. Divide in-store by pump users for canopy-to-store conversion.",
  },
  {
    view: "clarity",
    target: '[data-tour="health-feeds"]',
    title: "Camera Clarity",
    caption:
      "The model that watches the watchers. A fogged lens is flagged before your spill and shrink models silently miss things.",
  },
  {
    view: "faces",
    target: '[data-kiosk="face-matches"]',
    title: "Facial Recognition",
    caption:
      "SCRFD + ArcFace embeddings, pgvector match in Lakebase. Banned blinks red, VIP goes gold, staff goes blue - one model, three doctrines.",
  },
  {
    view: "detections",
    target: '[data-tour="detections-stream"]',
    title: "Live from the lakehouse",
    caption:
      "Not a screenshot - a row in Delta. Frame, detection, and model version land in Unity Catalog with ACID guarantees.",
  },
  {
    view: "trends",
    target: '[data-tour="trends-mix"]',
    title: "Composable, not siloed",
    caption:
      "The same rows feed this dashboard, the Genie space, and the weekly exec report. One source of truth, four interfaces.",
  },
  {
    view: "overview",
    target: '[data-kiosk="genie"]',
    title: "Ask LensIQ in plain English",
    caption:
      "Once footage is rows in Delta, anyone can ask: 'which stores had the most spills this week?' Genie answers over the same governed tables.",
  },
];

interface KioskGeometry {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CursorPos {
  x: number;
  y: number;
}

interface KioskContextValue {
  /** Sticky on/off from the header toggle (and ?kiosk=true). */
  armed: boolean;
  /** True while the loop is actively advancing (false when paused on a click). */
  playing: boolean;
  index: number;
  phase: Phase;
  stop: KioskStop | null;
  cursor: CursorPos | null;
  rect: KioskGeometry | null;
  toggle: () => void;
  /** Turn the kiosk off (used when the presenter launches the guided tour). */
  disarm: () => void;
}

const KioskContext = createContext<KioskContextValue | null>(null);

export function useKiosk(): KioskContextValue {
  const ctx = useContext(KioskContext);
  if (!ctx) throw new Error("useKiosk must be used inside <KioskProvider>");
  return ctx;
}

export function KioskProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();

  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("move");
  const [cursor, setCursor] = useState<CursorPos | null>(null);
  const [rect, setRect] = useState<KioskGeometry | null>(null);

  // Resume-after-inactivity timer. Cleared/reset on each real interaction.
  const resumeTimerRef = useRef<number | null>(null);
  // Preserve query params (presenterMode, kiosk) across simulated navigation.
  const searchRef = useRef(location.search);
  searchRef.current = location.search;

  const stop = armed ? (KIOSK_STOPS[index] ?? null) : null;

  const clearResume = useCallback(() => {
    if (resumeTimerRef.current != null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  const disarm = useCallback(() => {
    clearResume();
    setArmed(false);
    setPlaying(false);
    setCursor(null);
    setRect(null);
  }, [clearResume]);

  const toggle = useCallback(() => {
    setArmed((prev) => {
      if (prev) {
        clearResume();
        setPlaying(false);
        setCursor(null);
        setRect(null);
        return false;
      }
      setIndex(0);
      setPhase("move");
      setPlaying(true);
      return true;
    });
  }, [clearResume]);

  // Auto-start from ?kiosk=true so a booth machine can deep-link straight
  // into the loop without anyone touching the header control.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("kiosk") === "true") {
      setIndex(0);
      setPhase("move");
      setArmed(true);
      setPlaying(true);
    }
  }, []);

  // The per-stop "movie". Re-runs whenever we (re)enter a stop or resume.
  useEffect(() => {
    if (!armed || !playing) return;
    const current = KIOSK_STOPS[index];
    if (!current) return;

    let cancelled = false;
    const timers: number[] = [];

    // Phase 1 - glide the cursor to the sidebar nav item for this stop.
    setPhase("move");
    setRect(null);
    const navEl = document.querySelector(
      `[data-nav="${current.view}"]`,
    ) as HTMLElement | null;
    if (navEl) {
      const r = navEl.getBoundingClientRect();
      setCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    } else {
      // Sidebar collapsed (mobile): aim the cursor at the header instead so
      // the movement still reads, then let navigate() do the work.
      setCursor({ x: window.innerWidth / 2, y: 72 });
    }

    // Phase 2 - click ripple + actually navigate.
    timers.push(
      window.setTimeout(() => {
        if (cancelled) return;
        setPhase("click");
        if (window.location.pathname !== `/${current.view}`) {
          navigate(`/${current.view}${searchRef.current}`);
        }
      }, MOVE_MS),
    );

    // Phase 3 - resolve the section, scroll it into view, glow + caption.
    timers.push(
      window.setTimeout(() => {
        if (cancelled) return;
        setPhase("look");
        _resolveTarget(current.target, (geo) => {
          if (cancelled) return;
          setRect(geo);
          if (geo) {
            // Park the cursor just inside the highlighted section.
            setCursor({
              x: geo.left + Math.min(geo.width / 2, 140),
              y: geo.top + Math.min(geo.height / 2, 40),
            });
          }
        });
      }, MOVE_MS + CLICK_MS),
    );

    // Phase 4 - advance and loop.
    timers.push(
      window.setTimeout(() => {
        if (cancelled) return;
        setIndex((i) => (i + 1) % KIOSK_STOPS.length);
      }, MOVE_MS + CLICK_MS + DWELL_MS),
    );

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [armed, playing, index, navigate]);

  // Keep the highlight glued to the section while it's on screen (the page
  // can reflow as live data streams in).
  useEffect(() => {
    if (!armed || phase !== "look" || !stop) return;
    const update = () => {
      const el = document.querySelector(stop.target) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [armed, phase, stop]);

  // Pause on any *real* interaction, then resume after a quiet period. The
  // kiosk's own clicks are programmatic navigate() calls (no pointer event),
  // so they never trip this; only a human tapping the screen does. Clicks on
  // kiosk-owned chrome (data-kiosk-ui) are ignored.
  useEffect(() => {
    if (!armed) return;
    const onInteract = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-kiosk-ui]")) return;
      setPlaying(false);
      setRect(null);
      clearResume();
      resumeTimerRef.current = window.setTimeout(() => {
        resumeTimerRef.current = null;
        setPlaying(true);
      }, KIOSK_INACTIVITY_RESUME_MS);
    };
    window.addEventListener("pointerdown", onInteract, true);
    window.addEventListener("keydown", onInteract, true);
    return () => {
      window.removeEventListener("pointerdown", onInteract, true);
      window.removeEventListener("keydown", onInteract, true);
    };
  }, [armed, clearResume]);

  // Belt-and-suspenders: clear the resume timer on unmount.
  useEffect(() => clearResume, [clearResume]);

  const value = useMemo<KioskContextValue>(
    () => ({ armed, playing, index, phase, stop, cursor, rect, toggle, disarm }),
    [armed, playing, index, phase, stop, cursor, rect, toggle, disarm],
  );

  return (
    <KioskContext.Provider value={value}>
      {children}
      {armed ? <KioskOverlay /> : null}
    </KioskContext.Provider>
  );
}

function KioskOverlay() {
  const { playing, index, phase, stop, cursor, rect, disarm } = useKiosk();
  if (!stop) return null;

  const clicking = phase === "click";

  return (
    <div className="fixed inset-0 z-[9998] pointer-events-none" aria-hidden="true">
      {/* Section highlight: a glowing ring around the live UI, never a dimmer
          - the page stays fully visible and usable underneath. */}
      {rect && phase === "look" && (
        <div
          className="absolute rounded-xl kiosk-highlight"
          style={{
            top: rect.top - 8,
            left: rect.left - 8,
            width: rect.width + 16,
            height: rect.height + 16,
          }}
        />
      )}

      {/* Fake cursor that glides between the sidebar and the section. */}
      {cursor && (
        <div
          className="absolute kiosk-cursor"
          style={{ top: cursor.y, left: cursor.x }}
        >
          {clicking && <span key={index} className="kiosk-ripple" />}
          <MousePointer2 className="w-6 h-6 text-slate-900 fill-white drop-shadow-md" />
        </div>
      )}

      {/* Caption banner - bottom center, out of the way of the visuals.
          pointer-events-auto so the close (X) control is clickable even
          though the rest of the overlay lets clicks pass through. */}
      <div
        data-kiosk-ui
        className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[min(680px,92vw)] pointer-events-auto"
      >
        <div className="rounded-xl bg-slate-900/92 text-white shadow-2xl backdrop-blur px-5 py-3.5">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-lava-300">
              <span
                className={`w-1.5 h-1.5 rounded-full bg-lava-400 ${playing ? "animate-pulse" : ""}`}
              />
              {playing ? "Auto demo" : "Paused"}
            </span>
            <span className="text-sm font-semibold">{stop.title}</span>
            <span className="ml-auto text-[10px] text-slate-400">
              {index + 1} / {KIOSK_STOPS.length}
            </span>
            <button
              onClick={disarm}
              className="-my-1 -mr-1 ml-1 p-1 text-slate-400 hover:text-white transition-colors"
              aria-label="Stop kiosk demo"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm leading-snug text-slate-100">{stop.caption}</p>
          {/* Per-stop dwell progress bar (purely cosmetic motion cue). */}
          <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-white/15">
            <div
              key={`${index}-${playing}`}
              className="h-full bg-lava-400"
              style={{
                animation: playing
                  ? `kioskDwell ${(MOVE_MS + CLICK_MS + DWELL_MS) / 1000}s linear forwards`
                  : "none",
                width: playing ? undefined : "100%",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Poll for the target selector until it mounts (the route change may not have
// rendered yet), scroll it into view, then hand back its rect one frame later
// so the post-scroll geometry has settled. Calls back with null on timeout.
function _resolveTarget(
  selector: string,
  cb: (geo: KioskGeometry | null) => void,
): void {
  const start = performance.now();
  const tick = () => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        cb({ top: r.top, left: r.left, width: r.width, height: r.height });
      });
      return;
    }
    if (performance.now() - start > TARGET_LOOKUP_TIMEOUT_MS) {
      cb(null);
      return;
    }
    window.setTimeout(tick, TARGET_LOOKUP_INTERVAL_MS);
  };
  tick();
}
