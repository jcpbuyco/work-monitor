import { band, log10, logTicks } from "./scales.ts";
import { measureText } from "./measureText.ts";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";
import { YAxis, yAxisGutter } from "./Axis.tsx";
import { useRootPx } from "../../useRootPx.ts";
import { TICK_CLASS, TICK_PX_AT_16, VALUE_PX_AT_16, LABEL_HALO, scaleOf } from "./typography.ts";
import { compactUsd } from "./format.ts";

export interface DotStripPoint {
  id: string;
  month: string;
  value: number;
  label?: string; // direct label for a top-N outlier, already truncated to fit
  /** The untruncated name `label` was cut down from, if it was -- an SVG
   *  `<title>` on the label itself, so a mouse user gets the full name on a
   *  plain hover even before the richer tooltip kicks in (reviewer finding,
   *  A18: a 24-char slice with no way to see what was cut). */
  fullLabel?: string;
  /** Accessible name -- always rendered (never dropped just because a visual
   *  tooltip also exists, per the a11y finding: a screen-reader user gets no
   *  hover, so `aria-label` is their ONLY way to know what a dot is). Falls
   *  back to a bare run id when the caller doesn't supply one. */
  ariaLabel?: string;
  tooltip?: React.ReactNode;
  onClick?: () => void;
}

/** Deterministic string hash -> [0,1), so a run's jitter position never moves
 *  between renders (§6, C7: "never random, so renders are stable"). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Log-scale jittered dot strip, one point per workflow run, grouped by month
 *  band -- distribution plus outliers (§6, C7). */
export function DotStrip({
  points,
  months,
  medianByMonth,
  width,
  plotHeight,
  axisBand = 24,
  formatMonth = (m: string) => m,
}: {
  points: DotStripPoint[];
  months: string[];
  medianByMonth: Record<string, number | null>;
  width: number;
  plotHeight: number;
  axisBand?: number;
  formatMonth?: (month: string) => string;
}) {
  const tooltip = useTooltip();
  const rootPx = useRootPx();
  const scale = scaleOf(rootPx);
  const values = points.map((p) => p.value).filter((v) => v > 0);
  const minV = Math.min(0.1, ...values);
  const maxV = Math.max(1, ...values);
  const ticks = logTicks(minV, maxV);
  // TOP_PAD (matching StepLines/StackedColumns' own convention, §B7): without
  // it, the single highest-value dot sat exactly at y=0, its own radius
  // bleeding above the SVG's drawn area into the card's padding above it
  // (reviewer finding, O4).
  const TOP_PAD = 8 * scale;
  const scaleY = log10([ticks[0], ticks[ticks.length - 1]], [plotHeight, TOP_PAD]);
  // A left gutter for the y-axis's own tick labels (§6/B7), same as every
  // other axis on the page -- ticks used to draw at x=0, right on top of the
  // band's own dots and month labels underneath them (reviewer finding).
  const gutter = yAxisGutter(ticks, compactUsd, rootPx);
  const { at, bandwidth } = band(months, [gutter, width], 0.15);

  // Top-N outlier labels are few (<= 3, per the card's own contract), and the
  // whole point of "outliers" is that they cluster near the top of the SAME
  // busy month -- an offset relative to each dot's own y still let two labels
  // land on the same row whenever the log scale placed their dots close
  // together (a $116 run and a $62 run sit only ~17px apart on a 4-decade
  // axis). Anchoring every label's row to a FIXED position near the plot top
  // instead (rank order, one row apart, never relative to the dot) guarantees
  // three distinct rows regardless of how close the values are (pixel-picky
  // finding: two of these used to render on the same baseline as one garbled
  // word). Each label keeps its own dot's x, so it still reads as "pointing
  // at" roughly the right cluster.
  const labelY = new Map<string, number>();
  {
    const labeled = points
      .filter((p) => p.value > 0 && p.label)
      .sort((a, b) => b.value - a.value);
    // 18px row pitch, not 12 -- a `<text>` element's own rendered ink extends
    // well past its nominal font-size (ascent + descender), so two rows only
    // 12px (and, still measurably, 15px) apart overlapped by a few px once
    // the background rects (sized to match) sat back-to-back rather than with
    // real clearance (reviewer finding, O4).
    labeled.forEach((p, i) => labelY.set(p.id, (14 + i * 18) * scale));
  }

  const clampX = (x: number) => Math.min(Math.max(x, 0), width);
  // An outlier label's CENTRE, not just its dot's x, clamped to stay inside
  // the plot -- the label is wider than the dot it names, so clamping only
  // the dot still let a label near either edge bleed into the card's own
  // padding (reviewer finding, A18/O4). The padding around the measured text
  // (matching the background rect's own `+/-3`/`+6` below) scales by `scale`
  // too, not a flat px constant -- at a larger text size that gap between the
  // "true" and clamped half-width was itself a few px, enough on its own to
  // read as "still bleeding past the edge" (reviewer finding, O4).
  const labelPad = 3 * scale;
  const clampXWithHalfWidth = (x: number, label: string) => {
    const halfW = measureText(label, VALUE_PX_AT_16 * scale) / 2 + labelPad;
    return Math.min(Math.max(x, halfW), width - halfW);
  };

  return (
    <div className="relative">
      <svg width={width} height={plotHeight + axisBand} className="overflow-visible">
        <YAxis ticks={ticks} y={scaleY} width={width} format={compactUsd} x0={gutter} />
        {months.map((m) => (
          <text
            key={m}
            x={clampX(at(m) + bandwidth / 2)}
            y={plotHeight + 14 * scale}
            textAnchor="middle"
            className={TICK_CLASS}
            style={LABEL_HALO}
          >
            {formatMonth(m)}
          </text>
        ))}
        {points.map((p) => {
          if (p.value <= 0) return null;
          const jitter = hash01(p.id);
          const x = at(p.month) + bandwidth * 0.15 + jitter * bandwidth * 0.7;
          const y = scaleY(p.value);
          return (
            <g
              key={p.id}
              tabIndex={0}
              role={p.onClick ? "button" : "img"}
              aria-label={p.ariaLabel ?? `run ${p.id}`}
              style={p.onClick ? { cursor: "pointer" } : undefined}
              onClick={p.onClick}
              onKeyDown={(e) => {
                tooltip.onKeyDown(e);
                if (p.onClick && (e.key === "Enter" || e.key === " ")) p.onClick();
              }}
              onMouseEnter={(e) => p.tooltip && tooltip.showFromEvent(e, p.tooltip)}
              onMouseMove={(e) => p.tooltip && tooltip.showFromEvent(e, p.tooltip)}
              onMouseLeave={tooltip.hide}
              onFocus={(e) => p.tooltip && tooltip.showFromElement(e.currentTarget, p.tooltip)}
              onBlur={tooltip.hide}
            >
              <circle cx={x} cy={y} r={4} fill="var(--viz-s1)" fillOpacity={0.6} stroke="hsl(var(--surface-1))" strokeWidth={2} />
            </g>
          );
        })}
        {/* Medians draw AFTER every dot (never before, DOM/paint order is
            z-order here): a busy month's cluster of dots used to paint clean
            over the median tick underneath it, so only the quietest month's
            median was ever visible (reviewer finding, B11). A value label
            names what was otherwise an unlabelled mark. */}
        {months.map((m) => {
          const med = medianByMonth[m];
          if (med == null) return null;
          const x = at(m) + bandwidth / 2;
          const y = scaleY(med);
          const label = compactUsd(med);
          const lw = measureText(label, TICK_PX_AT_16 * scale);
          const lx = x + 10 * scale;
          return (
            <g key={`med-${m}`}>
              <line x1={x - 8 * scale} x2={x + 8 * scale} y1={y} y2={y} className="stroke-ink-2" strokeWidth={2} strokeLinecap="round" />
              {/* A surface-colour background behind the median label, not just
                 the glyph-stroke halo -- a busy month's dot cluster can still
                 sit right where this label reads, and the halo alone only
                 occludes a dot that crosses an actual LETTERFORM, not the gaps
                 between them (reviewer finding, O4, same fix as the Month
                 pace end labels' own background). */}
              <rect x={lx - 2 * scale} y={y - 7 * scale} width={lw + 4 * scale} height={14 * scale} rx={3} className="fill-surface-1" fillOpacity={0.9} />
              <text x={lx} y={y} dominantBaseline="central" className={TICK_CLASS}>
                {label}
              </text>
            </g>
          );
        })}
        {/* Top-N labels render in their OWN pass, after every dot, so a later
            dot can never paint over an earlier outlier's label (finding: a
            label drawn inline inside its own point could be covered by a
            dot from a LATER point in the array sharing the same screen
            area). */}
        {points.map((p) => {
          if (p.value <= 0 || !p.label) return null;
          const jitter = hash01(p.id);
          const dotX = at(p.month) + bandwidth * 0.15 + jitter * bandwidth * 0.7;
          const x = clampXWithHalfWidth(dotX, p.label);
          const ly = labelY.get(p.id) ?? 10;
          const w = measureText(p.label, VALUE_PX_AT_16 * scale);
          return (
            // No `pointer-events-none` when the name was actually truncated:
            // a plain hover needs to reach this group's own `<title>` for the
            // full name (reviewer finding, A18) -- otherwise (short enough to
            // show whole) it stays click-through, as before.
            <g key={`label-${p.id}`} className={p.fullLabel && p.fullLabel !== p.label ? undefined : "pointer-events-none"}>
              {p.fullLabel && p.fullLabel !== p.label && <title>{p.fullLabel}</title>}
              {/* A short leader line back to the dot whenever clamping moved
                 the label away from directly above it -- otherwise a label
                 shoved in from the edge no longer visually "points at" the
                 cluster it names (reviewer finding, O4). */}
              {Math.abs(x - dotX) > 1 && (
                <line x1={x} y1={ly + 6 * scale} x2={dotX} y2={scaleY(p.value)} className="stroke-ink-4" strokeWidth={1} strokeDasharray="2 2" />
              )}
              <rect x={x - w / 2 - labelPad} y={ly - 9 * scale} width={w + 2 * labelPad} height={12 * scale} rx={3} className="fill-surface-1" fillOpacity={0.9} />
              <text x={x} y={ly} textAnchor="middle" className="fill-ink-3 text-2xs tabular-nums">
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
      <Tooltip state={tooltip.state} />
    </div>
  );
}
