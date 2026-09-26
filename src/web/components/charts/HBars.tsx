import { linear, niceTicks } from "./scales.ts";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";

export interface HBarRow {
  id: string;
  label: string;
  value: number;
  directLabel: string;
  /** A reference tick on the same axis (C8's list-price mark), if any. */
  reference?: number;
  tooltip?: React.ReactNode;
}

const BAR_H = 20;
const GAP = 8;

/** Sorted horizontal bars (magnitude comparison, long category names): a
 *  4px-rounded end, at most 20px thick, with a direct end label and an
 *  optional thin reference tick per bar sharing the same axis (§6, C8). */
export function HBars({ rows, width, formatAxis }: { rows: HBarRow[]; width: number; formatAxis: (v: number) => string }) {
  const tooltip = useTooltip();
  const labelWidth = 132;
  const plotWidth = Math.max(80, width - labelWidth - 90);
  const max = Math.max(1, ...rows.map((r) => r.value), ...rows.map((r) => r.reference ?? 0));
  const ticks = niceTicks(max, 3);
  const scaleX = linear([0, ticks[ticks.length - 1]], [0, plotWidth]);
  const height = rows.length * (BAR_H + GAP);

  return (
    <div className="relative">
      <svg width={width} height={height} className="overflow-visible">
        {rows.map((r, i) => {
          const y = i * (BAR_H + GAP);
          const w = Math.max(2, scaleX(r.value));
          return (
            <g
              key={r.id}
              tabIndex={0}
              role="img"
              aria-label={`${r.label}: ${r.directLabel}`}
              onMouseEnter={(e) => r.tooltip && tooltip.showFromEvent(e, r.tooltip)}
              onMouseMove={(e) => r.tooltip && tooltip.showFromEvent(e, r.tooltip)}
              onMouseLeave={tooltip.hide}
              onFocus={(e) => r.tooltip && tooltip.showFromElement(e.currentTarget, r.tooltip)}
              onBlur={tooltip.hide}
            >
              <text x={labelWidth - 8} y={y + BAR_H / 2 + 4} textAnchor="end" className="fill-ink-2 text-[11px]">
                {r.label}
              </text>
              <rect x={labelWidth} y={y} width={w} height={BAR_H} rx={4} fill="var(--viz-s1)" />
              {r.reference != null && (
                <rect x={labelWidth + scaleX(r.reference) - 1} y={y - 3} width={2} height={BAR_H + 6} fill="var(--viz-context)" />
              )}
              <text x={labelWidth + w + 6} y={y + BAR_H / 2 + 4} className="fill-ink-2 text-[10px] tabular-nums font-medium">
                {r.directLabel}
              </text>
            </g>
          );
        })}
      </svg>
      <Tooltip state={tooltip.state} />
    </div>
  );
}
