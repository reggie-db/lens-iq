// LensIQ brand mark + lockups. The aperture iris is built from the same
// six-blade generator documented in client/public/brand-kit.html so any
// change to blade count / shades / inset stays in lock-step with the kit.

const LAVA_SHADES = [
  "#FF9E94", // lava 400
  "#FF7A66",
  "#FF5F46", // lava 500
  "#FF3621", // lava 600 (primary pop)
  "#E12D1C",
  "#BD2B26", // lava 700
] as const;

const NAVY_800 = "#1B3139";

interface IrisOptions {
  phi?: number;
  gap?: number;
  gapIn?: number;
}

function _polar(deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

// Build the six aperture-blade <path> elements for an iris of outer radius
// `R` and inner (open-center) radius `r`. Returns a list of {d, fill}.
function _buildBlades(
  R: number,
  r: number,
  opts: IrisOptions = {},
): Array<{ d: string; fill: string }> {
  const { phi = 30, gap = 3.0, gapIn = 7 } = opts;
  const N = 6;
  const step = 360 / N;
  const cx = R;
  const cy = R;
  const blades: Array<{ d: string; fill: string }> = [];
  for (let k = 0; k < N; k++) {
    const a = k * step;
    const [ox1, oy1] = _polar(a + gap);
    const [ox2, oy2] = _polar(a + step - gap);
    const [ix1, iy1] = _polar(a + phi + gapIn);
    const [ix2, iy2] = _polar(a + step + phi - gapIn);
    const O1 = [cx + R * ox1, cy + R * oy1];
    const O2 = [cx + R * ox2, cy + R * oy2];
    const I1 = [cx + r * ix1, cy + r * iy1];
    const I2 = [cx + r * ix2, cy + r * iy2];
    const d =
      `M${O1[0].toFixed(2)},${O1[1].toFixed(2)} ` +
      `A${R},${R} 0 0 1 ${O2[0].toFixed(2)},${O2[1].toFixed(2)} ` +
      `L${I2[0].toFixed(2)},${I2[1].toFixed(2)} ` +
      `L${I1[0].toFixed(2)},${I1[1].toFixed(2)} Z`;
    blades.push({ d, fill: LAVA_SHADES[k] });
  }
  return blades;
}

interface ApertureIconProps {
  size?: number;
  className?: string;
  title?: string;
}

// The standalone aperture mark - used as logo, favicon, and inside lockups.
export function ApertureIcon({ size = 32, className, title = "LensIQ" }: ApertureIconProps) {
  const R = size / 2;
  const blades = _buildBlades(R, R * 0.31);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
      className={className}
      style={{ display: "block" }}
    >
      <title>{title}</title>
      {blades.map((b, i) => (
        <path key={i} d={b.d} fill={b.fill} />
      ))}
    </svg>
  );
}

interface LensIQLogoProps {
  iconSize?: number;
  wordmarkSize?: number;
  showSub?: boolean;
  onDark?: boolean;
  className?: string;
}

// Horizontal lockup: aperture + "LensIQ" wordmark (+ optional "powered by
// Databricks" sub-line). Mirrors primaryLockup() in the brand kit.
export function LensIQLogo({
  iconSize = 36,
  wordmarkSize = 22,
  showSub = false,
  onDark = false,
  className,
}: LensIQLogoProps) {
  const subSize = Math.round(wordmarkSize * 0.5);
  const wordmarkColor = onDark ? "#FFFFFF" : NAVY_800;
  const subColor = onDark ? "#C4CCD6" : "#5A6F77";
  return (
    <div className={`flex items-center gap-3 ${className ?? ""}`}>
      <ApertureIcon size={iconSize} />
      <div className="flex flex-col leading-none">
        <span
          style={{
            fontFamily: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
            fontWeight: 500,
            letterSpacing: "-0.035em",
            fontSize: `${wordmarkSize}px`,
            lineHeight: 0.92,
            color: wordmarkColor,
          }}
        >
          Lens<span style={{ color: wordmarkColor }}>IQ</span>
        </span>
        {showSub && (
          <span
            style={{
              fontFamily: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
              fontWeight: 400,
              letterSpacing: "0.01em",
              fontSize: `${subSize}px`,
              marginTop: `${Math.round(wordmarkSize * 0.18)}px`,
              color: subColor,
            }}
          >
            powered by Databricks
          </span>
        )}
      </div>
    </div>
  );
}
