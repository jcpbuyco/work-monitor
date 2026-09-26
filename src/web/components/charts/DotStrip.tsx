import { band, log10, logTicks } from "./scales.ts";
import { measureText } from "./measureText.ts";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";

export interface DotStripPoint {
  id: string;
  month: string;
  value: number;
  label?: string; // direct label for a top-N outlier
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
  const values = points.map((p) => p.value).filter((v) => v > 0);
  const minV = Math.min(0.1, ...values);
  const maxV = Math.max(1, ...values);
  const ticks = logTicks(minV, maxV);
  const scaleY = log10([ticks[0], ticks[ticks.length - 1]], [plotHeight, 0]);
  const { at, bandwidth } = band(months, [0, width], 0.15);

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
    labeled.forEach((p, i) => labelY.set(p.id, 14 + i * 12));
  }

  return (
    <div className="relative">
      <svg width={width} height={plotHeight + axisBand} className="overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={0} x2={width} y1={scaleY(t)} y2={scaleY(t)} className="stroke-border-weak" strokeWidth={1} />
            {/* clamp: the topmost decade tick sits at y=0 -- see Axis.tsx's YAxis for why. */}
            <text x={0} y={Math.max(9, scaleY(t) - 3)} className="fill-ink-4 text-[10px]">
              {t < 1 ? `$${t.toFixed(2)}` : `$${t}`}
            </text>
          </g>
        ))}
        {months.map((m) => (
          <text key={m} x={at(m) + bandwidth / 2} y={plotHeight + 14} textAnchor="middle" className="fill-ink-4 text-[10px]">
            {formatMonth(m)}
          </text>
        ))}
        {months.map((m) => {
          const med = medianByMonth[m];
          if (med == null) return null;
          const x = at(m) + bandwidth / 2;
          return (
            <g key={`med-${m}`}>
              <line x1={x - 8} x2={x + 8} y1={scaleY(med)} y2={scaleY(med)} stroke="var(--viz-context)" strokeWidth={2} />
            </g>
          );
        })}
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
        {/* Top-N labels render in their OWN pass, after every dot, so a later
            dot can never paint over an earlier outlier's label (finding: a
            label drawn inline inside its own point could be covered by a
            dot from a LATER point in the array sharing the same screen
            area). */}
        {points.map((p) => {
          if (p.value <= 0 || !p.label) return null;
          const jitter = hash01(p.id);
          const x = at(p.month) + bandwidth * 0.15 + jitter * bandwidth * 0.7;
          const ly = labelY.get(p.id) ?? 10;
          const w = measureText(p.label, 9);
          return (
            <g key={`label-${p.id}`} className="pointer-events-none">
              <rect x={x - w / 2 - 3} y={ly - 9} width={w + 6} height={12} rx={3} className="fill-surface-1" fillOpacity={0.9} />
              <text x={x} y={ly} textAnchor="middle" className="fill-ink-3 text-[9px]">
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
