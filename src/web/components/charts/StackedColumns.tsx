import { useState } from "react";
import { band, linear, niceTicks } from "./scales.ts";
import { YAxis, yAxisGutter, thinBandLabels } from "./Axis.tsx";
import { measureText } from "./measureText.ts";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";
import { useRootPx } from "../../useRootPx.ts";
import { TICK_CLASS, VALUE_CLASS, VALUE_PX_AT_16, TICK_PX_AT_16, LABEL_HALO, scaleOf, xAxisBandPx } from "./typography.ts";

export interface StackedSeries {
  id: string;
  label: string;
  color: string;
}

export interface StackedColumnsProps {
  months: string[];
  series: StackedSeries[];
  /** month -> seriesId -> value (always >= 0; a missing entry is 0). */
  values: Record<string, Record<string, number>>;
  width: number;
  plotHeight: number;
  axisBand?: number;
  formatValue: (v: number) => string;
  formatAxis?: (v: number) => string;
  isolated?: string | null;
  /** Per-month text under the x label (C3's MoM delta, C6's run count). */
  secondLine?: (month: string) => string | null;
  /** Direct label ABOVE the column (C6's workflow-share %). */
  aboveLabel?: (month: string) => string | null;
  /** Column-total label on the cap -- false in a Share (100%) view, where
   *  every column reads "100%" and the label only crowds the legend and
   *  `aboveLabel` with no information (finding: C5/C6's share toggle). */
  showTotal?: boolean;
  currentMonth?: string;
  projection?: { month: string; to: number; label: string } | null;
  tooltipFor?: (month: string) => React.ReactNode;
  onClickSegment?: (month: string, seriesId: string) => void;
  /** Display text for a month's x-axis tick -- defaults to the raw "YYYY-MM"
   *  key. Callers pass a short form ("Sep", "Sep MTD"): the full ISO string
   *  does not fit an 8-month axis at phone width (pixel-picky finding: it
   *  used to collide with its own MoM-delta line underneath it). */
  formatMonth?: (month: string) => string;
}

const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** One fitted form for EVERY column's second line, not each column fitted
 *  independently -- dropping trailing words per-column in isolation let one
 *  narrow column read "163" while its neighbour, a few px wider, still fit
 *  the full "46 runs": two spellings of the same unit in one row (reviewer
 *  finding, R4). Finds the fewest trailing words to drop so the WIDEST
 *  raw label across the whole row fits every column's shared bandwidth, then
 *  applies that same drop count to all of them; a `null` entry (no second
 *  line that month) stays `null`. */
function uniformSecondLines(raw: (string | null)[], maxWidth: number, px: number): (string | null)[] {
  const present = raw.filter((r): r is string => r != null);
  if (present.length === 0) return raw;
  const maxWords = Math.max(...present.map((r) => r.split(" ").length));
  for (let drop = 0; drop < maxWords; drop++) {
    const widest = Math.max(...present.map((r) => measureText(r.split(" ").slice(0, Math.max(1, r.split(" ").length - drop)).join(" "), px)));
    if (widest <= maxWidth || drop === maxWords - 1) {
      return raw.map((r) => (r == null ? null : r.split(" ").slice(0, Math.max(1, r.split(" ").length - drop)).join(" ")));
    }
  }
  return raw;
}

/** Stacked columns: fixed segment order (never re-sorted), a max 24px column
 *  width, a 2px surface-color gap between segments, a 4px rounded top ONLY on
 *  the topmost visible (>0) segment, square at the baseline, and a total
 *  printed on the cap. Used by C3 (spend by model family), C5 (cost by token
 *  class) and C6 (who does the work). */
export function StackedColumns({
  months,
  series,
  values,
  width,
  plotHeight,
  axisBand = 32,
  formatValue,
  formatAxis,
  isolated,
  secondLine,
  aboveLabel,
  showTotal = true,
  currentMonth,
  projection,
  tooltipFor,
  onClickSegment,
  formatMonth = (m) => m,
}: StackedColumnsProps) {
  const [focused, setFocused] = useState<string | null>(null);
  const tooltip = useTooltip();
  const rootPx = useRootPx();
  const scale = scaleOf(rootPx);
  const totals = months.map((m) => series.reduce((s, sr) => s + (values[m]?.[sr.id] ?? 0), 0));
  const max = Math.max(1, ...totals, projection?.to ?? 0);
  const ticks = niceTicks(max, 4);
  const niceMax = ticks[ticks.length - 1];
  // TOP_PAD (§B7): a few px of headroom above y=0 so a near-max column's cap
  // total, drawn just above its bar, never crowds the card's own subtitle
  // sitting right above the SVG. A column that draws BOTH a cap total AND an
  // `aboveLabel` (C6's workflow-share %, stacked a second row higher still)
  // needs noticeably more of it: for a near-max column, the share label's own
  // target position sits above y=0 and gets floored back down onto the SAME
  // row as the total it's supposed to sit above -- this used to be a fixed
  // 8px regardless of whether a second label was even stacked up there
  // (reviewer finding, O7/R5-adjacent: "'$5.3k' x '48%'" collided at every
  // width, not just a narrow one, because the floor -- not a width-driven
  // wrap -- was the actual cause).
  const TOP_PAD = (showTotal && aboveLabel ? 40 : 8) * scale;
  const scaleY = linear([0, niceMax], [plotHeight, TOP_PAD]);
  // A left gutter for the y-axis's own tick labels (§6/B7): without it, a
  // tick drawn at x=0 sat directly on top of the first column's cap total or
  // ran into the plot's own baseline, worst at phone width (reviewer
  // finding, "$0$11").
  const gutter = yAxisGutter(ticks, formatAxis, rootPx);
  const { at, step, bandwidth } = band(months, [gutter, width], 0.35);
  const barWidth = Math.min(MAX_BAR, bandwidth);
  const currentIndex = currentMonth != null ? months.indexOf(currentMonth) : undefined;
  const tickPx = TICK_PX_AT_16 * scale;
  const bandLabels = thinBandLabels(months.map(formatMonth), currentIndex, step, tickPx, scale);
  const secondLineRaw = secondLine ? months.map((m) => secondLine(m)) : null;
  const uniformSecondLine = secondLineRaw ? uniformSecondLines(secondLineRaw, bandwidth, tickPx) : null;
  // The axis band (§R5) has to fit whichever is taller: the caller's own
  // budget, or two lines of the CURRENT (scaled) tick size -- a flat 32px
  // default fit the old fixed 9/10px labels, but a second line at a larger
  // text size painted 5-8px past a fixed band into the card's own bottom
  // padding below the SVG (reviewer finding, R5).
  const effectiveAxisBand = Math.max(axisBand, xAxisBandPx(rootPx, uniformSecondLine ? 2 : 1));

  return (
    <div className="relative">
    <svg width={width} height={plotHeight + effectiveAxisBand} className="overflow-visible">
      <YAxis ticks={ticks} y={scaleY} width={width} format={formatAxis} x0={gutter} />
      {months.map((month, mi) => {
        const x = at(month) + (bandwidth - barWidth) / 2;
        let cursor = plotHeight;
        const segs = series.map((s) => {
          const v = values[month]?.[s.id] ?? 0;
          // scaleY(0) is the plot's baseline (== plotHeight for a [0, niceMax]
          // -> [plotHeight, 0] scale), so this is just "bar height in px" --
          // NOT `plotHeight - scaleY(v) === plotHeight`, which reads as "is v
          // zero?" but is actually true whenever v equals the axis's OWN max
          // (scaleY(niceMax) = 0, so plotHeight - 0 === plotHeight), silently
          // zeroing out any segment that alone fills the whole y axis -- e.g.
          // every single-kind month in C6's Share view, where that one
          // segment IS the full 100% (reviewer finding: the bar vanished,
          // leaving a floating "100%" label over nothing).
          const h = v <= 0 ? 0 : scaleY(0) - scaleY(v);
          const y = cursor - h;
          cursor -= h > 0 ? h + GAP : 0;
          return { s, v, y, h };
        });
        const visible = segs.filter((sg) => sg.h > 0);
        const topId = visible.length ? visible[visible.length - 1].s.id : null;
        const total = totals[months.indexOf(month)];
        const isCurrent = month === currentMonth;
        return (
          <g
            key={month}
            role="img"
            tabIndex={0}
            aria-label={`${month}: ${formatValue(total)}`}
            onMouseEnter={(e) => tooltipFor && tooltip.showFromEvent(e, tooltipFor(month))}
            onMouseMove={(e) => tooltipFor && tooltip.showFromEvent(e, tooltipFor(month))}
            onMouseLeave={tooltip.hide}
            onFocus={(e) => {
              setFocused(month);
              if (tooltipFor) tooltip.showFromElement(e.currentTarget, tooltipFor(month));
            }}
            onBlur={() => {
              setFocused(null);
              tooltip.hide();
            }}
            onKeyDown={(e) => tooltip.onKeyDown(e)}
          >
            {/* full-band hit area */}
            <rect x={at(month)} y={0} width={bandwidth} height={plotHeight} fill="transparent" />
            {segs.map((sg) => {
              if (sg.h <= 0) return null;
              const dimmed = isolated != null && isolated !== sg.s.id;
              const isTop = sg.s.id === topId;
              const label = formatValue(sg.v);
              const labelW = measureText(label, VALUE_PX_AT_16 * scale);
              const fits = sg.h >= 18 * scale && labelW + 8 * scale <= barWidth;
              const clickable = onClickSegment != null;
              return (
                <g
                  key={sg.s.id}
                  style={{ opacity: dimmed ? 0.15 : 1, cursor: clickable ? "pointer" : undefined }}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable ? `${sg.s.label}, ${month}: ${formatValue(sg.v)}` : undefined}
                  onClick={() => onClickSegment?.(month, sg.s.id)}
                  onKeyDown={(e) => {
                    if (clickable && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onClickSegment?.(month, sg.s.id);
                    }
                  }}
                >
                  <path
                    d={
                      isTop
                        ? roundedTopRect(x, sg.y, barWidth, sg.h, RADIUS)
                        : `M${x},${sg.y} h${barWidth} v${sg.h} h${-barWidth} Z`
                    }
                    fill={sg.s.color}
                    // A hairline surface-color stroke around every segment (not
                    // just the low-contrast ones) so a fill that sits near the
                    // validator's light-end-contrast floor -- C6's neutral
                    // "main session" step, by design the ordinal ramp's
                    // lightest end -- still reads as a bounded, present shape
                    // against the card surface rather than relying on fill
                    // contrast alone.
                    stroke="hsl(var(--border-weak))"
                    strokeWidth={0.5}
                  />
                  {fits && (
                    <text
                      x={x + barWidth / 2}
                      y={sg.y + sg.h / 2 + 3 * scale}
                      textAnchor="middle"
                      className="pointer-events-none fill-white text-2xs font-medium tabular-nums"
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
            {projection && projection.month === month && projection.to > total && (
              <g>
                <rect
                  x={x}
                  y={scaleY(projection.to)}
                  width={barWidth}
                  height={Math.max(0, scaleY(total) - scaleY(projection.to))}
                  fill="none"
                  stroke="var(--viz-context)"
                  strokeDasharray="3 2"
                  strokeWidth={1}
                  rx={RADIUS}
                />
                <text
                  x={x + barWidth / 2}
                  y={scaleY(projection.to) - 5 * scale}
                  textAnchor="middle"
                  className="fill-ink-3 text-3xs"
                  style={LABEL_HALO}
                >
                  {projection.label}
                </text>
              </g>
            )}
            {showTotal && total > 0 && (
              <text x={x + barWidth / 2} y={scaleY(total) - 6 * scale} textAnchor="middle" className={VALUE_CLASS} style={LABEL_HALO}>
                {formatValue(total)}
              </text>
            )}
            {bandLabels[mi] != null && (
              <text
                x={at(month) + bandwidth / 2}
                y={plotHeight + 14 * scale}
                textAnchor="middle"
                className={`text-3xs ${isCurrent ? "fill-ink-2 font-medium" : "fill-ink-4"}`}
                style={LABEL_HALO}
              >
                {bandLabels[mi]}
              </text>
            )}
            {/* Only under a SHOWN primary label (never floating under a month
               whose own tick was thinned away above) -- and using the row's
               one uniformly-fitted form (§R4), not a per-column independent
               fit. */}
            {bandLabels[mi] != null && uniformSecondLine?.[mi] != null && (
              // 30, not 26: a 12px line-to-line gap (scaled) was tight enough
              // that a tall glyph in the second line (the "↑"/"↓" delta
              // arrows) still clipped into the first line's own text above it
              // by a few px (reviewer finding, R5-adjacent).
              <text x={at(month) + bandwidth / 2} y={plotHeight + 30 * scale} textAnchor="middle" className={TICK_CLASS} style={LABEL_HALO}>
                {uniformSecondLine[mi]}
              </text>
            )}
            {aboveLabel?.(month) && (
              <text
                x={x + barWidth / 2}
                // Only reserve room for the cap-total label when one is
                // actually drawn (`showTotal`) -- in Share mode there is
                // none, and the old fixed -20 offset plus a y=10 floor is
                // exactly what pinned every workflow-share label to the same
                // row as the (now-removed) "100%" caps (reviewer finding).
                // 32, not 20: at a larger scaled text size the cap-total
                // label's own (also-scaled) line height ate into the old
                // margin, overlapping this label's bottom edge by a few px
                // (reviewer finding, O7). Measured empirically against the
                // real rendered glyph bounding boxes, not just the baseline
                // math, since a `<text>` element's ink extends well above and
                // below its own `y` (no `dominantBaseline` override here).
                //
                // A small ABSOLUTE floor (just clearing the SVG's own top
                // edge), not one tied to `TOP_PAD` -- `TOP_PAD` already grew
                // to give a near-max column's stacked total+share pair real
                // headroom (so their un-floored positions land comfortably
                // apart on their own), and flooring at `TOP_PAD` itself
                // undid exactly that: it pulled a SMALLER, still-legitimately
                // -placed target back up to sit almost on top of its own
                // total, which is the collision this floor exists to prevent
                // in the first place (regression found while re-verifying).
                y={Math.max(4 * scale, scaleY(total) - (showTotal && total > 0 ? 32 * scale : 6 * scale))}
                textAnchor="middle"
                className="fill-ink-3 text-3xs font-medium"
                style={LABEL_HALO}
              >
                {aboveLabel(month)}
              </text>
            )}
            {focused === month && <rect x={at(month)} y={0} width={bandwidth} height={plotHeight} fill="none" stroke="var(--focus-ring, currentColor)" strokeWidth={1} rx={2} className="text-ink pointer-events-none opacity-40" />}
          </g>
        );
      })}
    </svg>
    <Tooltip state={tooltip.state} />
    </div>
  );
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${w - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} Z`;
}
