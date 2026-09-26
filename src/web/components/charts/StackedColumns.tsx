import { useState } from "react";
import { band, linear, niceTicks } from "./scales.ts";
import { YAxis } from "./Axis.tsx";
import { measureText } from "./measureText.ts";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";

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
  const totals = months.map((m) => series.reduce((s, sr) => s + (values[m]?.[sr.id] ?? 0), 0));
  const max = Math.max(1, ...totals, projection?.to ?? 0);
  const ticks = niceTicks(max, 4);
  const niceMax = ticks[ticks.length - 1];
  const scaleY = linear([0, niceMax], [plotHeight, 0]);
  const { at, bandwidth } = band(months, [0, width], 0.35);
  const barWidth = Math.min(MAX_BAR, bandwidth);

  return (
    <div className="relative">
    <svg width={width} height={plotHeight + axisBand} className="overflow-visible">
      <YAxis ticks={ticks} y={scaleY} width={width} format={formatAxis} />
      {months.map((month) => {
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
              const labelW = measureText(label, 10);
              const fits = sg.h >= 18 && labelW + 8 <= barWidth;
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
                      y={sg.y + sg.h / 2 + 3}
                      textAnchor="middle"
                      className="pointer-events-none fill-white text-[9px] tabular-nums"
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
                <text x={x + barWidth / 2} y={scaleY(projection.to) - 5} textAnchor="middle" className="fill-ink-3 text-[9px]">
                  {projection.label}
                </text>
              </g>
            )}
            {showTotal && total > 0 && (
              <text x={x + barWidth / 2} y={scaleY(total) - 6} textAnchor="middle" className="fill-ink-2 text-[10px] tabular-nums font-medium">
                {formatValue(total)}
              </text>
            )}
            <text
              x={at(month) + bandwidth / 2}
              y={plotHeight + 14}
              textAnchor="middle"
              className={`text-[10px] ${isCurrent ? "fill-ink-2 font-medium" : "fill-ink-4"}`}
            >
              {formatMonth(month)}
            </text>
            {secondLine?.(month) && (
              <text x={at(month) + bandwidth / 2} y={plotHeight + 26} textAnchor="middle" className="fill-ink-4 text-[9px] tabular-nums">
                {secondLine(month)}
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
                y={Math.max(10, scaleY(total) - (showTotal && total > 0 ? 20 : 6))}
                textAnchor="middle"
                className="fill-ink-3 text-[9px] font-medium"
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
