import { linear, niceTicks } from "./scales.ts";
import { measureText } from "./measureText.ts";
import { useTooltip } from "./useTooltip.ts";
import { Tooltip } from "./Tooltip.tsx";
import { useRootPx } from "../../useRootPx.ts";
import { TICK_CLASS, VALUE_CLASS, TICK_PX_AT_16, VALUE_PX_AT_16, LABEL_HALO, scaleOf } from "./typography.ts";

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
const AXIS_BAND = 20;

/** Truncate `text` with a trailing ellipsis until it measures within
 *  `maxWidth` at `px` -- same idea as `DotStrip`'s outlier-label truncation,
 *  generalised for the category column here (reviewer finding, R3: a long
 *  model name plus a long value string no longer both fit at a narrow width
 *  and a large scaled text size). */
function truncateToWidth(text: string, maxWidth: number, px: number): string {
  if (measureText(text, px) <= maxWidth) return text;
  let end = text.length - 1;
  while (end > 1 && measureText(`${text.slice(0, end)}…`, px) > maxWidth) end--;
  return `${text.slice(0, end)}…`;
}

/** Sorted horizontal bars (magnitude comparison, long category names): a
 *  4px-rounded end, at most 20px thick, with a direct end label and an
 *  optional thin reference tick per bar sharing the same axis (§6, C8). A
 *  bottom value axis (hairline gridlines + ticks) so the bars read against an
 *  actual scale -- this was the one magnitude chart on the page with no axis
 *  at all (reviewer finding, B10). */
export function HBars({
  rows,
  width,
  formatAxis,
  height,
}: {
  rows: HBarRow[];
  width: number;
  formatAxis: (v: number) => string;
  /** The card body's own measured height, if it's been stretched taller than
   *  this chart's natural size (e.g. by a taller sibling sharing an `lg:grid`
   *  row) -- when given and larger than the natural plot, the extra room goes
   *  into the row PITCH (more breathing room between bars), not left as dead
   *  space below the last bar (reviewer finding, O3). */
  height?: number;
}) {
  const tooltip = useTooltip();
  const rootPx = useRootPx();
  const scale = scaleOf(rootPx);
  // The category column caps at 38% of the available width (never the flat
  // `132 * scale` alone) -- at a narrow width and a large scaled text size,
  // that flat column plus even the SHORTEST usable plot and a value label
  // together needed more room than the card actually had, and a fixed column
  // does not shrink to make room the way this cap does (reviewer finding,
  // R3). Row labels that don't fit this column get truncated with an
  // ellipsis (`<title>` on the row already carries the full name).
  const labelWidth = Math.min(132 * scale, Math.max(56 * scale, width * 0.38));
  const catPx = 11 * scale; // text-2xs
  const truncatedLabels = rows.map((r) => truncateToWidth(r.label, labelWidth - 8 * scale, catPx));
  // The plot's right-hand headroom has to fit the WIDEST direct end label
  // actually being drawn there, measured at its real (scaled) size -- a flat
  // `90 * scale` guess fit the old fixed 9/10px labels, but a longer value
  // string ("$416 · 8.3x list") at a scaled-up text size ran 4-20px past the
  // card's own right edge with no relationship to how wide that guess
  // happened to be (reviewer finding, R3).
  const valuePx = VALUE_PX_AT_16 * scale;
  const valueWidths = rows.map((r) => measureText(r.directLabel, valuePx, 500));
  const maxLabelWidth = valueWidths.length ? Math.max(...valueWidths) : 0;
  const labelGap = 6 * scale;
  const plotWidth = Math.max(80, width - labelWidth - maxLabelWidth - labelGap - 4 * scale);
  const max = Math.max(1, ...rows.map((r) => r.value), ...rows.map((r) => r.reference ?? 0));
  // Thin the tick count until adjacent tick labels (measured at their real
  // scaled size) can no longer collide -- `niceTicks(max, 3)` alone ignores
  // how wide its own labels render, so "$0"/"$200"/"$400"/"$600" garbled into
  // "$0$20$40$600" once text scaled up on a narrow plot (reviewer finding,
  // R3). Always keeps at least the axis max (`niceTicks`'s own floor of a
  // single [0] tick).
  const tickPx = TICK_PX_AT_16 * scale;
  let ticks = niceTicks(max, 3);
  for (let count = 3; count >= 1; count--) {
    const candidate = niceTicks(max, count);
    ticks = candidate;
    if (candidate.length <= 1) break;
    const pitch = plotWidth / (candidate.length - 1);
    const widest = Math.max(...candidate.map((t) => measureText(formatAxis(t), tickPx)));
    if (widest + 8 * scale <= pitch) break;
  }
  const scaleX = linear([0, ticks[ticks.length - 1]], [0, plotWidth]);
  const barH = BAR_H * scale;
  const naturalRowPitch = (BAR_H + GAP) * scale;
  const naturalPlotHeight = rows.length * naturalRowPitch;
  const axisBand = AXIS_BAND * scale;
  const availablePlotHeight = height != null ? Math.max(naturalPlotHeight, height - axisBand) : naturalPlotHeight;
  const rowPitch = rows.length > 0 ? availablePlotHeight / rows.length : naturalRowPitch;
  const plotHeight = availablePlotHeight;
  const svgHeight = plotHeight + axisBand;

  return (
    <div className="relative">
      <svg width={width} height={svgHeight} className="overflow-visible">
        {/* Value axis: hairline gridlines through every bar, ticks along the
            bottom -- same convention as every other magnitude chart's YAxis,
            rotated 90deg since this one plots horizontally. */}
        {ticks.map((t) => {
          const x = labelWidth + scaleX(t);
          return (
            <g key={t}>
              <line x1={x} x2={x} y1={0} y2={plotHeight} className={t === 0 ? "stroke-border" : "stroke-border-weak"} strokeWidth={1} />
              <text x={x} y={plotHeight + 14 * scale} textAnchor="middle" className={TICK_CLASS} style={LABEL_HALO}>
                {formatAxis(t)}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          const rowY = i * rowPitch;
          const y = rowY + (rowPitch - barH) / 2;
          const w = Math.max(2, scaleX(r.value));
          // Outside the bar (the normal case) when there's room; otherwise
          // INSIDE it, right-aligned in white, rather than running past the
          // card's own right edge -- the fallback the R3 finding asked for
          // when even a correctly-measured reservation isn't enough room
          // (a long category name eating most of a narrow card at a large
          // text size leaves no combination of bar + outside label that
          // fits).
          const fitsOutside = labelWidth + w + labelGap + valueWidths[i] <= width - 2 * scale;
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
              <title>{r.label}</title>
              <text x={labelWidth - 8 * scale} y={y + barH / 2} dominantBaseline="central" textAnchor="end" className="fill-ink-2 text-2xs">
                {truncatedLabels[i]}
              </text>
              <rect x={labelWidth} y={y} width={w} height={barH} rx={4} fill="var(--viz-s1)" />
              {r.reference != null && (
                <rect x={labelWidth + scaleX(r.reference) - 1} y={y - 3 * scale} width={2} height={barH + 6 * scale} fill="var(--viz-context)" />
              )}
              {fitsOutside ? (
                <text x={labelWidth + w + 6 * scale} y={y + barH / 2} dominantBaseline="central" className={VALUE_CLASS}>
                  {r.directLabel}
                </text>
              ) : (
                <text
                  x={Math.max(labelWidth + 4 * scale, labelWidth + w - 6 * scale)}
                  y={y + barH / 2}
                  dominantBaseline="central"
                  textAnchor="end"
                  className="fill-white text-2xs font-medium tabular-nums"
                >
                  {r.directLabel}
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
