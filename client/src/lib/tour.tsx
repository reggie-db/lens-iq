import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@databricks/appkit-ui/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

// Guided product tour that mirrors the DAIS talk track in
// `docs/dais-talk-track.md`. Each step either highlights a real UI element
// (via a `data-tour="<id>"` attribute) or renders centered on the screen for
// narrative beats that don't tie to a single component.
//
// Implementation notes:
// - Spotlight is a single fixed div placed over the target rect with a giant
//   box-shadow spread, so the inverse-cutout is just CSS - no SVG masks.
// - When a step has a `route`, we navigate first, then poll for the target
//   selector to appear (up to TARGET_LOOKUP_TIMEOUT_MS) before rendering.
// - We keep the page interactive (pointer-events: none on the dimmer) so the
//   demo presenter can still drive the UI while the overlay is up.

const TARGET_LOOKUP_INTERVAL_MS = 80;
const TARGET_LOOKUP_TIMEOUT_MS = 2500;
const SPOTLIGHT_PADDING_PX = 8;
const TOOLTIP_OFFSET_PX = 14;
const TOOLTIP_WIDTH_PX = 380;

type Placement = "top" | "bottom" | "left" | "right" | "center";

export interface TourStep {
  id: string;
  /** Optional route to navigate to before measuring the target. */
  route?: string;
  /** CSS selector for the element to spotlight. Omit for centered narrative. */
  target?: string;
  /** Tooltip headline. */
  title: string;
  /** Tooltip body. Plain text or JSX. */
  body: React.ReactNode;
  /** Where to place the tooltip relative to the target. Ignored when centered. */
  placement?: Placement;
}

// Talk-track-aligned tour. Numbers/labels track the headings in
// docs/dais-talk-track.md so the spoken delivery and on-screen flow stay
// in sync.
export const TOUR_STEPS: TourStep[] = [
  {
    id: "hook",
    title: "From cameras to actioned outcomes",
    body: (
      <>
        <p>
          Every retailer in this room already has the data. It's stuck on the
          wrong side of a coax cable.
        </p>
        <p className="mt-2">
          In the next few minutes you'll watch a frame leave a camera, hit a
          Databricks-served model, land in Unity Catalog, render here, and
          trigger an operator action that flows back to the lakehouse - all
          in one workspace.
        </p>
      </>
    ),
    placement: "center",
  },
  {
    id: "architecture",
    title: "All on Databricks",
    body: (
      <>
        <p>
          Cameras &rarr; Zerobus (direct gRPC into Unity Catalog) &rarr; Model
          Serving &rarr; this app &rarr; Lakebase Postgres for transactional
          write-back, synced back to UC for analytics.
        </p>
        <p className="mt-2 text-slate-500">
          One workspace. One governance surface. One{" "}
          <code className="text-xs">databricks bundle deploy</code>.
        </p>
      </>
    ),
    placement: "center",
  },
  {
    id: "live-source",
    route: "/live",
    target: '[data-tour="live-source"]',
    placement: "right",
    title: "Pick a source",
    body: (
      <>
        <p>
          Webcam for the laptop demo, sample MP4 clips for repeatable
          deliveries, RTSP from your IP cameras in production.
        </p>
        <p className="mt-2 text-slate-500">
          The sample clips are proxied through the AppKit server so the
          canvas isn't tainted - inference works on canned footage as well as
          live cameras.
        </p>
      </>
    ),
  },
  {
    id: "live-model",
    route: "/live",
    target: '[data-tour="live-detector"]',
    placement: "right",
    title: "One endpoint per use case",
    body: (
      <>
        <p>
          Each detector is its own <b>UC-registered PyFunc on its own serving
          endpoint</b>: spill, plate, wet-floor sign, cigarette/vape,
          slip-and-fall, plus a pure-Python fog/lens-condition classifier.
        </p>
        <p className="mt-2 text-slate-500">
          Independent versioning, scale-to-zero, and cost per detector. Add
          one by parameterizing the same deploy notebook with a new model
          slug - no shared cold-start to coordinate.
        </p>
      </>
    ),
  },
  {
    id: "live-video",
    route: "/live",
    target: '[data-tour="live-video"]',
    placement: "top",
    title: "Real-time inference, live overlay",
    body: (
      <>
        <p>
          Frames are downscaled client-side, sent to Model Serving, and the
          returned bounding boxes are scaled back into source pixels before
          the canvas paints them.
        </p>
        <p className="mt-2 text-slate-500">
          Endpoints scale to zero. The on-video spinner only escalates from
          "Detecting" to "Waking endpoint" when the cached serving-status
          confirms a cold start - so the indicator isn't lying.
        </p>
      </>
    ),
  },
  {
    id: "live-snapshot",
    route: "/live",
    target: '[data-tour="live-snapshot"]',
    placement: "top",
    title: "Persist on demand",
    body: (
      <>
        <p>
          Save Snapshot writes the frame to a Unity Catalog volume <i>and</i>{" "}
          inserts one row per detection. Same governance, same audit trail
          as your finance tables.
        </p>
        <p className="mt-2 text-slate-500">
          In production this path is replaced by Zerobus from the edge -
          sub-second ACKed gRPC straight into UC, no message broker required.
        </p>
      </>
    ),
  },
  {
    id: "detections-stream",
    route: "/detections",
    target: '[data-tour="detections-stream"]',
    placement: "top",
    title: "Live from the lakehouse",
    body: (
      <>
        <p>
          Server-Sent Events tail the <code className="text-xs">detections</code>{" "}
          table. Anything that writes there - this app, Zerobus from the
          edge, the SDP pipeline - surfaces here within a couple seconds.
        </p>
        <p className="mt-2 text-slate-500">
          No webhooks to configure. The lake is the bus.
        </p>
      </>
    ),
  },
  {
    id: "composable",
    route: "/trends",
    target: '[data-tour="trends-mix"]',
    placement: "top",
    title: "Composable, not siloed",
    body: (
      <>
        <p>
          The same UC tables that feed this React app feed your Lakeview
          dashboard, the Genie space your CFO uses, and the agent your data
          team is wiring up. One source of truth, four interfaces.
        </p>
        <p className="mt-2 text-slate-500">
          A static dashboard tells you something happened. This is the
          control surface that lets the operator <b>do</b> something about it.
        </p>
      </>
    ),
  },
  {
    id: "plates-vip",
    route: "/plates",
    target: '[data-tour="plates-recent"]',
    placement: "left",
    title: "Repeat-customer identification",
    body: (
      <>
        <p>
          Every plate the camera sees is joined to its history. Pull up
          frequency, average basket, last-seen-at.
        </p>
        <p className="mt-2 text-slate-500">
          When a 14-visits-a-month regular pulls in, the on-shift manager
          gets a Slack ping via the LLM tool-calling agent. Loyalty without
          an app or a punch card.
        </p>
      </>
    ),
  },
  {
    id: "camera-health",
    route: "/health",
    target: '[data-tour="health-feeds"]',
    placement: "top",
    title: "Camera health = model health",
    body: (
      <>
        <p>
          A fogged dome cam doesn't break - it silently feeds bad pixels into
          every downstream model. The pure-Python <code className="text-xs">fog_detector</code> endpoint
          watches the cameras themselves and flags the affected region.
        </p>
        <p className="mt-2 text-slate-500">
          Sustained fog opens a Lakebase-backed cleaning ticket. The store
          fixes the lens before the spill model, the ALPR model, and the
          PPE model all start under-counting.
        </p>
      </>
    ),
  },
  {
    id: "outcomes",
    title: "What this unlocks",
    body: (
      <>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <b>Spill time-to-cone</b> under 90s, audit-grade for insurance
            claims.
          </li>
          <li>
            <b>People-to-pump-to-store</b> conversion - the denominator
            you've never had.
          </li>
          <li>
            <b>Repeat-customer ID</b> in real time, without a loyalty app.
          </li>
          <li>
            <b>PPE compliance</b> as a coaching nudge by shift, not a
            write-up.
          </li>
          <li>
            <b>Pump-island fraud</b> alerts to loss prevention as it happens.
          </li>
          <li>
            <b>Camera-health monitoring</b> that catches lens fog or smudge
            before the models silently degrade.
          </li>
        </ul>
      </>
    ),
    placement: "center",
  },
  {
    id: "close",
    title: "Action the lake, don't just visualize it",
    body: (
      <>
        <p>
          You already pay for the cameras. You already pay for Databricks.
          The bridge between them used to be a six-month SI project.
        </p>
        <p className="mt-2">
          Today it's one bundle, one afternoon, and the whole loop -
          camera &rarr; lakehouse &rarr; operator &rarr; back to lakehouse -
          stays inside Databricks.
        </p>
      </>
    ),
    placement: "center",
  },
];

interface TourContextValue {
  active: boolean;
  index: number;
  step: TourStep | null;
  start: () => void;
  next: () => void;
  prev: () => void;
  stop: () => void;
  jumpTo: (index: number) => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used inside <TourProvider>");
  return ctx;
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();

  const step = active ? (TOUR_STEPS[index] ?? null) : null;

  // When a step has a `route`, navigate before the overlay tries to measure.
  useEffect(() => {
    if (!step?.route) return;
    if (window.location.pathname !== step.route) {
      navigate(step.route);
    }
  }, [step, navigate]);

  const start = useCallback(() => {
    setIndex(0);
    setActive(true);
  }, []);

  const stop = useCallback(() => {
    setActive(false);
  }, []);

  const next = useCallback(() => {
    setIndex((i) => {
      const ni = i + 1;
      if (ni >= TOUR_STEPS.length) {
        setActive(false);
        return 0;
      }
      return ni;
    });
  }, []);

  const prev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const jumpTo = useCallback((i: number) => {
    setIndex(Math.max(0, Math.min(TOUR_STEPS.length - 1, i)));
  }, []);

  // Keyboard nav: ESC to close, arrow keys to step.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stop();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, next, prev, stop]);

  const value = useMemo<TourContextValue>(
    () => ({ active, index, step, start, next, prev, stop, jumpTo }),
    [active, index, step, start, next, prev, stop, jumpTo],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      {active && step ? <TourOverlay step={step} /> : null}
    </TourContext.Provider>
  );
}

// Resolved geometry for the highlighted target. `null` means we couldn't
// find the element (treated as a centered step).
interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function TourOverlay({ step }: { step: TourStep }) {
  const { index, next, prev, stop } = useTour();
  const [rect, setRect] = useState<TargetRect | null>(null);

  // Poll for the target element until it appears (the route change may not
  // have rendered the page yet) or we time out and fall back to centered.
  useLayoutEffect(() => {
    setRect(null);
    if (!step.target) return;

    let cancelled = false;
    const start = performance.now();

    const tryResolve = () => {
      if (cancelled) return;
      const el = document.querySelector(step.target!) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        // Wait one frame post-scroll for the rect to settle.
        requestAnimationFrame(() => {
          if (cancelled) return;
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        });
        return;
      }
      if (performance.now() - start > TARGET_LOOKUP_TIMEOUT_MS) return;
      window.setTimeout(tryResolve, TARGET_LOOKUP_INTERVAL_MS);
    };

    tryResolve();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Recompute on window resize/scroll so the spotlight tracks the target.
  useEffect(() => {
    if (!step.target) return;
    const update = () => {
      const el = document.querySelector(step.target!) as HTMLElement | null;
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
  }, [step]);

  const centered = !step.target || rect == null;
  const placement = step.placement ?? (centered ? "center" : "bottom");
  const tooltipPosition = _computeTooltipPosition(rect, placement);

  return (
    <div
      className="fixed inset-0 z-[9999]"
      role="dialog"
      aria-modal="true"
      aria-label={`Tour: ${step.title}`}
    >
      {/* Dim layer. Pointer-events none so the presenter can still click the
          underlying UI; controls live on the tooltip card. */}
      {centered ? (
        <div className="absolute inset-0 bg-black/60 pointer-events-none" />
      ) : (
        rect && (
          <div
            className="absolute pointer-events-none rounded-lg"
            style={{
              top: rect.top - SPOTLIGHT_PADDING_PX,
              left: rect.left - SPOTLIGHT_PADDING_PX,
              width: rect.width + SPOTLIGHT_PADDING_PX * 2,
              height: rect.height + SPOTLIGHT_PADDING_PX * 2,
              boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.6)",
              outline: "2px solid rgb(220, 38, 38)",
              outlineOffset: 0,
              transition: "all 200ms ease-out",
            }}
          />
        )
      )}

      {/* Tooltip card */}
      <div
        className="absolute pointer-events-auto"
        style={tooltipPosition}
      >
        <div
          className="rounded-lg bg-white shadow-2xl border border-slate-200 p-5"
          style={{ width: TOOLTIP_WIDTH_PX }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Step {index + 1} of {TOUR_STEPS.length}
              </div>
              <div className="text-base font-semibold text-slate-900">
                {step.title}
              </div>
            </div>
            <button
              onClick={stop}
              className="text-slate-400 hover:text-slate-700 transition-colors -mt-1 -mr-1 p-1"
              aria-label="End tour"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-3 text-sm text-slate-700 leading-relaxed space-y-1">
            {step.body}
          </div>

          {/* Progress dots */}
          <div className="mt-4 flex items-center gap-1">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.id}
                className="h-1 flex-1 rounded-full transition-colors"
                style={{
                  backgroundColor: i <= index ? "rgb(220, 38, 38)" : "rgb(226, 232, 240)",
                }}
              />
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={prev}
              disabled={index === 0}
              className="gap-1"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={stop}>
                Skip
              </Button>
              <Button size="sm" onClick={next} className="gap-1">
                {index === TOUR_STEPS.length - 1 ? "Finish" : "Next"}
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Convert a target rect + placement into an absolute CSS position object for
// the tooltip. When the target is missing (centered narrative steps) the
// tooltip is anchored to the viewport center.
function _computeTooltipPosition(
  rect: TargetRect | null,
  placement: Placement,
): React.CSSProperties {
  if (!rect || placement === "center") {
    return {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  // Clamp so the tooltip stays on-screen even when the target is near an
  // edge. Half-tooltip-width worth of padding from viewport edges.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const TT_HEIGHT_GUESS = 260;
  const margin = 12;

  let top = 0;
  let left = 0;

  switch (placement) {
    case "right":
      left = rect.left + rect.width + TOOLTIP_OFFSET_PX;
      top = rect.top + rect.height / 2 - TT_HEIGHT_GUESS / 2;
      break;
    case "left":
      left = rect.left - TOOLTIP_WIDTH_PX - TOOLTIP_OFFSET_PX;
      top = rect.top + rect.height / 2 - TT_HEIGHT_GUESS / 2;
      break;
    case "top":
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH_PX / 2;
      top = rect.top - TT_HEIGHT_GUESS - TOOLTIP_OFFSET_PX;
      break;
    case "bottom":
    default:
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH_PX / 2;
      top = rect.top + rect.height + TOOLTIP_OFFSET_PX;
      break;
  }

  left = Math.max(margin, Math.min(left, vw - TOOLTIP_WIDTH_PX - margin));
  top = Math.max(margin, Math.min(top, vh - TT_HEIGHT_GUESS - margin));

  return { top, left };
}
