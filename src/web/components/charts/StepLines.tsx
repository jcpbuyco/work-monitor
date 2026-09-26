import { linear, niceTicks } from "./scales.ts";
import { YAxis } from "./Axis.tsx";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";

export interface StepSeries {
  month: string;
  label: string;
  /** cumulative value per day-of-month, index 0 = day 1; `null` beyond the
   *  month's own length or beyond "today" for the current month. */
  values: (number | null)[];
  emphasis: boolean;
}

export interface StepLinesProps {
  series: StepSeries[];
  width: number;
  plotHeight: number;
  axisBand?: number;
  todayIndex?: number; // 0-based day index "today" sits at, for the emphasis series' end dot
  projectionTo?: number | null; // dashed segment target value at the end of the CURRENT month
  projectionLabel?: string;
  /** Days in the current (emphasis) month -- the projection's dashed segment
   *  and end dot land here, NOT at a hardcoded day 31: a 30-day (or 28/29-day)
   *  month projected all the way to day 31 overshoots the axis by up to three
   *  days (reviewer finding). The x AXIS itself still always spans 1..31
   *  (§6: "x = day 1 to 31"), so different months stay comparable. */
  monthLength?: number;
  formatValue: (v: number) => string;
  onHoverDay?: (dayIndex: number | null) => void;
}

const DAYS = 31;
const LABEL_COLLISION_PX = 12;

/** Cumulative step lines (curveStepAfter -- a day with no usage carries the
 *  previous value forward as a flat step, never an interpolated slope). One
 *  emphasis line (current month, 2px accent + end dot) against up to 3
 *  context lines (1.5px `--viz-context`), with direct end labels instead of a
 *  legend box (§6, C4). */
export function StepLines({
  series,
  width,
  plotHeight,
  axisBand = 24,
  todayIndex,
  projectionTo,
  projectionLabel,
  monthLength = DAYS,
  formatValue,
  onHoverDay,
}: StepLinesProps) {
  const tooltip = useTooltip();
  const allValues = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = Math.max(1, ...allValues, projectionTo ?? 0);
  const ticks = niceTicks(max, 4);
  const niceMax = ticks[ticks.length - 1];
  const scaleY = linear([0, niceMax], [plotHeight, 0]);
  const scaleX = linear([1, DAYS], [0, width]);

  function pathFor(values: (number | null)[]): string {
    let d = "";
    let last: number | null = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      const x = scaleX(i + 1);
      if (last == null) d += `M${x},${scaleY(v)}`;
      else d += ` H${x} V${scaleY(v)}`;
      last = v;
    }
    return d;
  }

  function lastPoint(s: StepSeries): { idx: number; value: number } | null {
    for (let i = s.values.length - 1; i >= 0; i--) {
      const v = s.values[i];
      if (v != null) return { idx: i, value: v };
    }
    return null;
  }

  // 12px end-label collision drop (§6, C4): "if two end labels would sit
  // within 12px, the lower-priority one (older month) drops to the tooltip
  // and table instead of being nudged" -- this rule was entirely missing
  // (reviewer finding), so two close cumulative totals rendered overlapping,
  // barely-legible text. Priority is emphasis (current month) first, then
  // most-recent-to-oldest among the context lines -- `series` itself is
  // already ordered oldest..newest with the emphasis month last, so walking
  // it in REVERSE visits labels in priority order.
  const droppedLabels = new Set<string>();
  {
    const placed: number[] = [];
    for (const s of [...series].reverse()) {
      const p = lastPoint(s);
      if (!p) continue;
      const y = scaleY(p.value) + (s.emphasis ? -8 : 4);
      if (placed.some((py) => Math.abs(py - y) < LABEL_COLLISION_PX)) droppedLabels.add(s.month);
      else placed.push(y);
    }
  }

  const emphasisSeries = series.find((s) => s.emphasis);
  const prevSeries = series.length >= 2 ? series[series.length - 2] : undefined;

  const ticksX = [1, 8, 15, 22, 29];

  return (
    <div className="relative">
      <svg
        width={width}
        height={plotHeight + axisBand}
        className="overflow-visible"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const dayFloat = 1 + ((e.clientX - rect.left) / width) * (DAYS - 1);
          const day = Math.min(DAYS, Math.max(1, Math.round(dayFloat)));
          onHoverDay?.(day - 1);
          const rows = series
            .filter((s) => s.values[day - 1] != null)
            .map((s) => `${s.label}: ${formatValue(s.values[day - 1]!)}`)
            .join("\n");
          // "Sep vs Aug +$X (+Y%)" (§6, C4) -- current month against the
          // immediately preceding one, at this same day, was missing
          // entirely (reviewer finding).
          let deltaLine = "";
          const curV = emphasisSeries?.values[day - 1];
          const prevV = prevSeries?.values[day - 1];
          if (emphasisSeries && prevSeries && curV != null && prevV != null && prevV !== 0) {
            const diff = curV - prevV;
            const pct = (diff / prevV) * 100;
            const curName = emphasisSeries.label.split(" ")[0];
            const prevName = prevSeries.label.split(" ")[0];
            deltaLine = `\n${curName} vs ${prevName} ${diff >= 0 ? "+" : ""}${formatValue(diff)} (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`;
          }
          if (rows) tooltip.showFromEvent(e, <div className="whitespace-pre-line">{`Day ${day}\n${rows}${deltaLine}`}</div>);
        }}
        onMouseLeave={() => {
          onHoverDay?.(null);
          tooltip.hide();
        }}
      >
        <YAxis ticks={ticks} y={scaleY} width={width} format={formatValue} />
        {ticksX.map((d) => (
          <text key={d} x={scaleX(d)} y={plotHeight + 14} textAnchor="middle" className="fill-ink-4 text-[10px]">
            {d}
          </text>
        ))}
        {series.map((s) => {
          const p = lastPoint(s);
          if (!p) return null;
          const { idx: lastIdx, value: lastValue } = p;
          return (
            <g
              key={s.month}
              tabIndex={0}
              role="img"
              aria-label={`${s.label}: ${formatValue(lastValue)}`}
              // Keyboard focus previously did nothing at all -- a sighted
              // mouse user got the crosshair tooltip, a keyboard user got
              // silence despite the `tabIndex`/`aria-label` implying
              // otherwise (reviewer finding). This isn't the full crosshair
              // (that needs a day, not a series), but it surfaces the same
              // "label: value" the aria-label already carries.
              onFocus={(e) => tooltip.showFromElement(e.currentTarget, <div>{`${s.label}: ${formatValue(lastValue)}`}</div>)}
              onBlur={tooltip.hide}
            >
              <path
                d={pathFor(s.values)}
                fill="none"
                stroke={s.emphasis ? "var(--viz-s1)" : "var(--viz-context)"}
                strokeWidth={s.emphasis ? 2 : 1.5}
              />
              {s.emphasis && todayIndex != null && s.values[todayIndex] != null && (
                <circle cx={scaleX(todayIndex + 1)} cy={scaleY(s.values[todayIndex]!)} r={4} fill="var(--viz-s1)" />
              )}
              {s.emphasis && projectionTo != null && (
                <>
                  <line
                    x1={scaleX(lastIdx + 1)}
                    y1={scaleY(lastValue)}
                    x2={scaleX(monthLength)}
                    y2={scaleY(projectionTo)}
                    stroke="var(--viz-s1)"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                  />
                  <circle cx={scaleX(monthLength)} cy={scaleY(projectionTo)} r={4} fill="hsl(var(--surface-1))" stroke="var(--viz-s1)" strokeWidth={1.5} />
                  {projectionLabel && (
                    <text x={scaleX(monthLength) - 4} y={scaleY(projectionTo) - 8} textAnchor="end" className="fill-ink-3 text-[10px]">
                      {projectionLabel}
                    </text>
                  )}
                </>
              )}
              {!droppedLabels.has(s.month) && (
                <text
                  x={scaleX(lastIdx + 1) - 4}
                  y={scaleY(lastValue) + (s.emphasis ? -8 : 4)}
                  textAnchor="end"
                  className={`text-[10px] ${s.emphasis ? "fill-ink-2 font-medium" : "fill-ink-3"}`}
                >
                  {s.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip state={tooltip.state} />
    </div>
  );
}
