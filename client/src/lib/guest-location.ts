// Guest Location domain model: property geometry, consented-session events, and
// the queue economics that turn a live vehicle count into spend, balk, and a
// personalized menu.
//
// The split of what is real vs. modelled matters for the demo narrative:
//   - REAL: queue depth. It comes from YOLO vehicle detections on the
//     drive-through lane camera (see SAMPLE_VIDEOS `drive-thru-lane`).
//   - MODELLED: phone-location pings, POS transactions, spend, and menu
//     ranking. A booth demo has no opted-in phones or POS feed, so these are
//     deterministic functions of the live queue depth plus the operator's
//     slider inputs. Every surface that renders them labels them as modelled.
//
// The privacy stance the whole page is built to demonstrate: the app supplies
// identity and preferences, the camera supplies an anonymous position. No
// faces, plates, or persistent vehicle fingerprints are correlated - only
// "an anonymous arrival happened at roughly the same time as a consented app
// session", and that association is discarded when the visit ends.

/** Event colors, shared by the map legend, the markers, and the event list. */
export const EVENT_COLORS = {
  phone: "#0ea5e9",
  gap: "#94a3b8",
  camera: "#10b981",
  menu: "#a855f7",
} as const;

export type SessionEventKind = keyof typeof EVENT_COLORS;

/**
 * Anchor for the demo site, standing in for S-ATL-001 in the Overview fleet.
 *
 * These are the real coordinates of a fuel-and-convenience parcel in metro
 * Atlanta, taken from OpenStreetMap: roughly 92m by 123m at the corner of
 * Cobb Parkway (the arterial along its west edge) and Roswell Road (along the
 * north). The map is a real slippy map over OSM tiles, so the route below is
 * authored to that actual parcel rather than floating over whatever happens to
 * be underneath.
 */
export const SITE_CENTER: readonly [number, number] = [33.95045, -84.51983];

// Metres per degree at this latitude. Good to a fraction of a percent over a
// site a couple of hundred metres across, which is all the map ever shows.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((SITE_CENTER[0] * Math.PI) / 180);

/**
 * Convert a metre offset from SITE_CENTER into a lat/lng pair.
 *
 * Site geometry below is authored in metres east/north because that is how an
 * operator thinks about a forecourt ("the order point is 40m in from the
 * road"), and because GPS accuracy radii are quoted in metres. Keeping one
 * unit for both means the accuracy circles are physically honest on the map
 * instead of being a decorative halo.
 */
export function offsetToLatLng(east: number, north: number): [number, number] {
  return [SITE_CENTER[0] + north / M_PER_DEG_LAT, SITE_CENTER[1] + east / M_PER_DEG_LNG];
}

/**
 * One step in the consented-session walkthrough. `at` is seconds into the
 * session; `east`/`north` are metre offsets from SITE_CENTER.
 */
export interface SessionEvent {
  id: string;
  kind: SessionEventKind;
  at: number;
  east: number;
  north: number;
  title: string;
  detail: string;
  /**
   * Reported phone-location accuracy, in metres. Grows as the vehicle closes
   * on the building, which is the whole reason the camera handoff exists:
   * consumer GPS degrades exactly where the ordering decision happens.
   */
  accuracyM?: number;
}

/** Total session length in seconds. The last event closes the session out. */
export const SESSION_SECONDS = 50;

/**
 * Vehicle route across the site as metre offsets from SITE_CENTER. It follows
 * the real parcel: in westbound off Roswell Road at the north edge, south down
 * the forecourt past the pump islands, around to the order point and window on
 * the south side, then out onto Cobb Parkway at the west edge. The first and
 * last legs sit on the public roads on purpose, because that is where phone
 * location is still the only signal.
 */
export const SESSION_PATH_M: ReadonlyArray<readonly [number, number]> = [
  [140, 58], [92, 55], [50, 52], [32, 42], [26, 22],
  [22, 2], [18, -18], [8, -36], [-10, -46], [-32, -44],
  [-52, -36], [-68, -24], [-78, -10], [-84, 6],
];

export const SESSION_EVENTS: readonly SessionEvent[] = [
  {
    id: "approach",
    kind: "phone",
    at: 0,
    east: 130,
    north: 57,
    accuracyM: 45,
    title: "App detects customer near store",
    detail:
      "An opted-in app session reports a coarse position out on the arterial. Accuracy is tens of metres wide, but good enough to know which store is being approached.",
  },
  {
    id: "consent",
    kind: "phone",
    at: 7,
    east: 50,
    north: 52,
    accuracyM: 18,
    title: "Consented location session opens",
    detail:
      "The customer crosses the geofence and a temporary session id is minted. Identity and order history live here, on the app side, and never move to the camera.",
  },
  {
    id: "cam-entry",
    kind: "camera",
    at: 13,
    east: 32,
    north: 42,
    title: "Anonymous vehicle enters property",
    detail:
      "The entrance camera logs an arrival with no plate, face, or vehicle fingerprint. Timing alone puts it in the same window as the app session.",
  },
  {
    id: "gps-gap",
    kind: "gap",
    at: 19,
    east: 20,
    north: 2,
    accuracyM: 55,
    title: "Phone location degrades",
    detail:
      "Beside the building and under the canopy, reported accuracy blows out past 50m. On its own the app can no longer tell the drive-through lane from the pump islands.",
  },
  {
    id: "cam-lane",
    kind: "camera",
    at: 26,
    east: 18,
    north: -18,
    title: "Zone transition: lot to drive-through lane",
    detail:
      "The lane camera carries the anonymous session through the GPS gap. This is the handoff: position comes from cameras, identity stays with the app.",
  },
  {
    id: "cam-queue",
    kind: "camera",
    at: 33,
    east: 8,
    north: -36,
    title: "Queue position estimated",
    detail:
      "Counting vehicles between this session and the order point gives a place in line, and therefore a credible time-to-order.",
  },
  {
    id: "menu",
    kind: "menu",
    at: 38,
    east: -10,
    north: -46,
    title: "Personalized menu delivered",
    detail:
      "Order history from the app combines with live queue conditions from the cameras. A long line favors fast-to-produce favorites; a short line surfaces premium and customizable items.",
  },
  {
    id: "pickup",
    kind: "camera",
    at: 45,
    east: -32,
    north: -44,
    title: "Session closes at the window",
    detail:
      "The anonymous session reaches the pickup window and the visit ends. Nothing about the vehicle was ever identified.",
  },
  {
    id: "discard",
    kind: "phone",
    at: 50,
    east: -78,
    north: -10,
    accuracyM: 22,
    title: "Association discarded",
    detail:
      "The link between the app session and the camera session is deleted on exit. The next visit starts from scratch with a new temporary id.",
  },
];

interface PathSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  length: number;
}

// Segment lengths are fixed, so build them once at module load and reuse for
// every interpolation the scrubber asks for.
const PATH_SEGMENTS: readonly PathSegment[] = SESSION_PATH_M.slice(1).map((point, idx) => {
  const [ax, ay] = SESSION_PATH_M[idx] as readonly [number, number];
  const [bx, by] = point;
  return { ax, ay, bx, by, length: Math.hypot(bx - ax, by - ay) };
});

const PATH_LENGTH = PATH_SEGMENTS.reduce((sum, seg) => sum + seg.length, 0);

/** The route as lat/lng, ready to hand to a Leaflet polyline. */
export const SESSION_ROUTE: ReadonlyArray<[number, number]> = SESSION_PATH_M.map(([e, n]) =>
  offsetToLatLng(e, n),
);

/** Interpolate a lat/lng along the route at `progress` in 0..1. */
export function pointOnRoute(progress: number): [number, number] {
  const last = PATH_SEGMENTS[PATH_SEGMENTS.length - 1];
  if (!last) {
    const [e, n] = SESSION_PATH_M[0] as readonly [number, number];
    return offsetToLatLng(e, n);
  }
  let remaining = Math.min(1, Math.max(0, progress)) * PATH_LENGTH;
  for (const seg of PATH_SEGMENTS) {
    if (remaining <= seg.length) {
      const t = seg.length === 0 ? 0 : remaining / seg.length;
      return offsetToLatLng(seg.ax + (seg.bx - seg.ax) * t, seg.ay + (seg.by - seg.ay) * t);
    }
    remaining -= seg.length;
  }
  return offsetToLatLng(last.bx, last.by);
}

// ─── Queue economics ──────────────────────────────────────────────────

export type Daypart = "breakfast" | "lunch" | "dinner" | "late";
export type VehicleClass = "motorcycle" | "car" | "large";
export type Weather = "hot" | "mild" | "cold";

/** Seconds one lane takes to fully serve one vehicle, order through window. */
const SERVICE_SECONDS_PER_CAR = 42;

/** Baseline ticket by daypart, before party size and queue effects. */
const DAYPART_BASE_SPEND: Record<Daypart, number> = {
  breakfast: 9.4,
  lunch: 14.2,
  dinner: 16.8,
  late: 11.6,
};

export interface DemandInputs {
  /** Live vehicle count from the lane camera. The only real signal here. */
  queueDepth: number;
  daypart: Daypart;
  partySize: number;
  vehicleClass: VehicleClass;
  weather: Weather;
  staffedLanes: number;
}

export interface QueueEconomics {
  /** Estimated seconds from joining the line to pulling away. */
  waitSeconds: number;
  /** Share of arrivals that leave without ordering, 0..1. */
  balkRate: number;
  /** Vehicles observed by the camera over the sampled window. */
  carsDetected: number;
  /** Modelled POS transactions for the same window. */
  posOrders: number;
  /** carsDetected - posOrders. The gap the cameras make visible. */
  balkedCars: number;
  /** Modelled average ticket at this wait. */
  avgSpend: number;
  /** Ticket the same customer would have spent with no line. */
  uncongestedSpend: number;
  /** Revenue lost to balked vehicles over the window. */
  lostRevenue: number;
}

/**
 * Queue depth to wait time. Lanes serve in parallel, and a lone vehicle still
 * pays one full service cycle, so the depth is spread across staffed lanes
 * and floored at a single car.
 */
export function estimateWaitSeconds(queueDepth: number, staffedLanes: number): number {
  const lanes = Math.max(1, staffedLanes);
  return (Math.max(1, queueDepth) / lanes) * SERVICE_SECONDS_PER_CAR;
}

/**
 * Balk probability as a logistic function of wait. Calibrated so a sub-2
 * minute wait loses almost nobody and a 6 minute wait loses roughly a third,
 * which is the shape QSR operators describe. Modelled, not measured.
 */
export function balkRate(waitSeconds: number): number {
  const minutes = waitSeconds / 60;
  return 0.42 / (1 + Math.exp(-(minutes - 4.4) * 1.15));
}

/**
 * Average ticket. Party size scales it sublinearly (a second person adds
 * less than a full ticket), heat and cold nudge it, and a long wait pushes
 * customers toward simpler, cheaper orders.
 */
export function estimateSpend(inputs: DemandInputs, waitSeconds: number): number {
  const base = DAYPART_BASE_SPEND[inputs.daypart];
  const party = 1 + (Math.max(1, inputs.partySize) - 1) * 0.72;
  const vehicle = inputs.vehicleClass === "large" ? 1.12 : inputs.vehicleClass === "motorcycle" ? 0.78 : 1;
  const weather = inputs.weather === "mild" ? 1 : 1.05;
  // Order simplification under pressure: customers drop the extras first.
  const congestion = 1 - Math.min(0.24, Math.max(0, waitSeconds / 60 - 2) * 0.055);
  return base * party * vehicle * weather * congestion;
}

/** Roll the whole model up for a given live queue depth. */
export function computeEconomics(inputs: DemandInputs): QueueEconomics {
  const waitSeconds = estimateWaitSeconds(inputs.queueDepth, inputs.staffedLanes);
  const rate = balkRate(waitSeconds);
  const carsDetected = Math.max(0, Math.round(inputs.queueDepth));
  const balkedCars = Math.round(carsDetected * rate);
  const posOrders = Math.max(0, carsDetected - balkedCars);
  const avgSpend = estimateSpend(inputs, waitSeconds);
  const uncongestedSpend = estimateSpend(inputs, estimateWaitSeconds(1, inputs.staffedLanes));
  return {
    waitSeconds,
    balkRate: rate,
    carsDetected,
    posOrders,
    balkedCars,
    avgSpend,
    uncongestedSpend,
    lostRevenue: balkedCars * avgSpend,
  };
}

// ─── Personalization ──────────────────────────────────────────────────

/**
 * Menu item tags. Scenarios and live context boost tags rather than naming
 * items, so one scoring pass covers every scenario and the ranking visibly
 * reorders when the operator changes a slider.
 */
export type ItemTag =
  | "fast" | "premium" | "share" | "compact" | "cold" | "hot" | "addon" | "usual";

export interface MenuItem {
  name: string;
  price: number;
  prepSeconds: number;
  tags: ItemTag[];
}

export const MENU_ITEMS: readonly MenuItem[] = [
  { name: "The usual: #2 combo, no pickles", price: 11.75, prepSeconds: 55, tags: ["usual", "fast"] },
  { name: "Spicy chicken sandwich", price: 8.45, prepSeconds: 70, tags: ["fast"] },
  { name: "Double smash combo", price: 15.9, prepSeconds: 145, tags: ["premium"] },
  { name: "Build-your-own bowl", price: 14.25, prepSeconds: 210, tags: ["premium"] },
  { name: "Family bundle, 4 entrees", price: 38.5, prepSeconds: 240, tags: ["share", "premium"] },
  { name: "Shareable nugget tray", price: 19.2, prepSeconds: 130, tags: ["share"] },
  { name: "Iced coffee, large", price: 4.35, prepSeconds: 25, tags: ["cold", "fast", "addon"] },
  { name: "Frozen lemonade", price: 4.9, prepSeconds: 30, tags: ["cold", "fast"] },
  { name: "Hot drip coffee", price: 2.85, prepSeconds: 20, tags: ["hot", "fast", "addon"] },
  { name: "Breakfast burrito, handheld", price: 6.4, prepSeconds: 60, tags: ["compact", "fast"] },
  { name: "Hash rounds", price: 3.1, prepSeconds: 35, tags: ["addon", "fast", "compact"] },
  { name: "Cookie two-pack", price: 3.65, prepSeconds: 15, tags: ["addon", "share", "fast"] },
];

export interface Scenario {
  id: string;
  name: string;
  appSignal: string;
  cameraSignal: string;
  value: string;
  /** Tags this scenario leans on, strongest first. */
  emphasis: ItemTag[];
}

/**
 * The ten plays, expressed as tag emphasis so they all share one scoring
 * pass. Ordered roughly by how easily an operator can ship them.
 */
export const SCENARIOS: readonly [Scenario, ...Scenario[]] = [
  {
    id: "decision-compression",
    name: "Repeat-customer decision compression",
    appSignal: "Common orders for this customer",
    cameraSignal: "Anonymous session entered the ordering zone",
    value: "Faster decisions, shorter lines, higher repeat-order conversion.",
    emphasis: ["usual", "fast"],
  },
  {
    id: "queue-aware",
    name: "Queue-aware menu personalization",
    appSignal: "Purchase history and dietary preferences",
    cameraSignal: "Queue length and how fast it is moving",
    value: "Protects throughput at peak, lifts average order value off-peak.",
    emphasis: ["fast", "premium"],
  },
  {
    id: "high-value",
    name: "High-value customer queue optimization",
    appSignal: "Opted-in top-decile customer approaching",
    cameraSignal: "Vehicle count and approximate place in line",
    value: "Shorter waits for the best customers without visibly jumping the queue.",
    emphasis: ["usual", "fast"],
  },
  {
    id: "handoff",
    name: "Camera handoff across the GPS gap",
    appSignal: "Customer crossed the property geofence",
    cameraSignal: "Anonymous object tracked driveway to lane",
    value: "Removes wrong check-ins caused by poor GPS precision.",
    emphasis: ["usual"],
  },
  {
    id: "party-size",
    name: "Party-size-aware recommendations",
    appSignal: "Opted-in customer session",
    cameraSignal: "One occupant versus several, no identification",
    value: "Bigger baskets from a recommendation that fits the situation.",
    emphasis: ["share", "premium"],
  },
  {
    id: "vehicle-context",
    name: "Vehicle-context merchandising",
    appSignal: "Customer preferences",
    cameraSignal: "Broad class only: motorcycle, car, large vehicle",
    value: "Better relevance without ever identifying the vehicle.",
    emphasis: ["compact", "fast"],
  },
  {
    id: "substitution",
    name: "Inventory-aware personalized substitution",
    appSignal: "Predicted order for this customer",
    cameraSignal: "Vehicles ahead, and time until they order",
    value: "Saves the conversion before the customer hits a sold-out item.",
    emphasis: ["fast", "usual"],
  },
  {
    id: "weather",
    name: "Weather and exposure-aware offers",
    appSignal: "Arrival plus past preferences",
    cameraSignal: "In a vehicle, walking up, or waiting outside",
    value: "Context lifts conversion and the customer is more comfortable.",
    emphasis: ["cold", "hot"],
  },
  {
    id: "mission",
    name: "Convenience-store mission prediction",
    appSignal: "First-party purchase patterns",
    cameraSignal: "Heading to pump, lot, door, or lane",
    value: "Turns arrival intent into a cross-sell before the register.",
    emphasis: ["addon", "compact"],
  },
  {
    id: "promise-time",
    name: "Dynamic promise-time personalization",
    appSignal: "Whether this customer values speed or price",
    cameraSignal: "Live congestion across lane, curbside, and counter",
    value: "Balances demand across channels and uses idle capacity.",
    emphasis: ["fast", "addon"],
  },
];

export interface RankedItem extends MenuItem {
  score: number;
  /** Why this item surfaced, for the "we know you" explainer line. */
  reason: string;
}

/**
 * Score and rank the menu for the live context.
 *
 * The ranking is deliberately probabilistic rather than deterministic: it is
 * a suggestion, so being wrong costs a shrug instead of a bad experience.
 * That is the whole argument for this design over a "we know exactly who you
 * are" menu that has to be right every time.
 */
export function rankMenu(
  inputs: DemandInputs,
  scenario: Scenario,
  waitSeconds: number,
  limit = 4,
): RankedItem[] {
  const longWait = waitSeconds > 210;
  const scored = MENU_ITEMS.map((item) => {
    let score = 1;
    const reasons: string[] = [];

    // Scenario emphasis, weighted by position so the first tag dominates.
    scenario.emphasis.forEach((tag, idx) => {
      if (item.tags.includes(tag)) {
        score += 1.8 - idx * 0.5;
        reasons.push(scenario.emphasis.length > 1 && idx > 0 ? `${tag} fit` : `${tag} play`);
      }
    });

    // Live queue: a long line favors short prep, a short line makes room for
    // items the kitchen needs time to build.
    if (longWait && item.prepSeconds <= 70) {
      score += 1.3;
      reasons.push("holds the line");
    }
    if (!longWait && item.tags.includes("premium")) {
      score += 0.9;
      reasons.push("line is short");
    }
    if (longWait && item.prepSeconds > 150) score -= 1.4;

    if (inputs.partySize >= 3 && item.tags.includes("share")) {
      score += 1.1;
      reasons.push(`party of ${inputs.partySize}`);
    }
    if (inputs.partySize === 1 && item.tags.includes("share")) score -= 1.2;

    if (inputs.vehicleClass === "motorcycle") {
      score += item.tags.includes("compact") ? 1.2 : -0.5;
      if (item.tags.includes("compact")) reasons.push("easy to carry");
    }
    if (inputs.vehicleClass === "large" && item.tags.includes("share")) {
      score += 0.7;
      reasons.push("room for a bundle");
    }

    if (inputs.weather === "hot" && item.tags.includes("cold")) {
      score += 1.1;
      reasons.push("hot out");
    }
    if (inputs.weather === "cold" && item.tags.includes("hot")) {
      score += 1.1;
      reasons.push("cold out");
    }
    if (inputs.weather === "hot" && item.tags.includes("hot")) score -= 0.8;
    if (inputs.weather === "cold" && item.tags.includes("cold")) score -= 0.8;

    if (inputs.daypart === "breakfast" && /burrito|coffee|hash/i.test(item.name)) {
      score += 1;
      reasons.push("breakfast daypart");
    }

    return {
      ...item,
      score,
      reason: reasons.length > 0 ? reasons.slice(0, 2).join(", ") : "baseline",
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** mm:ss for a wait estimate. */
export function formatWait(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
