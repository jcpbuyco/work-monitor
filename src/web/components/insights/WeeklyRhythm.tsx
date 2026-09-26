import { useState } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd } from "../../cost.ts";
import { compactUsd } from "../charts/format.ts";
import { quantileEdges, binOf } from "../charts/scales.ts";
import { SEQ_VARS } from "../charts/palette.ts";
import { HeatGrid, type HeatCellData } from "../charts/HeatGrid.tsx";
import { ScaleLegend } from "../charts/ScaleLegend.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { TICK_CLASS } from "../charts/typography.ts";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { useMediaQuery } from "../../useMediaQuery.ts";
import { useRootPx } from "../../useRootPx.ts";
import { Segmented } from "../primitives.tsx";

type Metric = "hours" | "spend";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// 24px, not the old 20px: wide enough to fit "Wed"/"Thu"/"Sat"/"Sun" without
// clipping a glyph at the box edge (reviewer finding: "Wed" measured 21.3px
// in a 20px box, rendering as "Wec") -- matches the lifetime calendar's own
// row-label column, so both heat grids share one convention.
const LABEL_COL_W = 24;
const SPARKBAR_COL_W = 64;
const SPARKBAR_MAX_W = 24;
const ROW_GAP = 12; // must match the row's own `style={{ gap }}` below -- see A10

/** C10: 7x24 heatmap of active hours or spend by weekday/hour, sharing C9's
 *  5-step ramp (one sequential language on the page). Below 640px, hours fold
 *  into 8 columns of 3. */
export function WeeklyRhythm({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [metric, setMetric] = useState<Metric>("hours");
  const [view, setView] = useChartView();
  const narrow = useMediaQuery("(max-width: 639px)");
  const [ref, measuredWidth, measuredHeight] = useChartWidth<HTMLDivElement>();
  const rootPx = useRootPx();
  const scale = rootPx / 16;
  const labelColW = LABEL_COL_W * scale;
  const sparkbarColW = SPARKBAR_COL_W * scale;
  const rowGap = ROW_GAP * scale;

  // 24 hourly columns at the 14px minimum cell size never fit the card body
  // between about 1024 and 1560px (24*(14+2) + the weekday-label column + the
  // spend-sparkbar column overflows a ~448px two-column card body by roughly
  // 20px, worse at larger text sizes -- reviewer finding, blue bars spilling
  // into C11's card). A `Math.max(14, ...)` floor can never shrink far
  // enough to fix that on its own, so once 1-hour columns genuinely don't
  // fit, fold hours into wider bins (2h, 3h, ...) the same way the phone
  // layout already folds into 3h bins -- fewer, wider columns instead of
  // illegally-small or overflowing ones.
  const DESKTOP_BINS = [1, 2, 3, 4, 6];
  function fitsAt(bin: number): boolean {
    const availPx = measuredWidth - labelColW - sparkbarColW - 2 * rowGap;
    return availPx / (24 / bin) - 2 >= 14;
  }
  const binSize = narrow ? 3 : DESKTOP_BINS.find(fitsAt) ?? DESKTOP_BINS[DESKTOP_BINS.length - 1];
  const cols = 24 / binSize;
  const widthCellSize = Math.floor((measuredWidth - labelColW - sparkbarColW - 2 * rowGap) / cols) - 2;
  // A taller paired sibling (Leverage, sharing this `lg:grid` row) can
  // stretch this card's body well past its own natural height -- sizing
  // cells from width alone left that extra room as dead space below the grid
  // instead of growing into it (reviewer finding, O3). `measuredHeight` is
  // this component's own flex-stretched wrapper, so cells grow (still capped
  // at 22px) to fill whichever of width/height is tighter.
  const tickRowH = 14 * scale;
  const availGridH = measuredHeight - tickRowH - rowGap;
  const heightCellSize = Math.floor(availGridH / 7) - 2;
  const desktopCellSize = Math.max(14, Math.min(22, Math.min(widthCellSize, heightCellSize)));
  const cellSize = narrow ? 28 : desktopCellSize;

  const cellAt = new Map(data.weekHour.map((c) => [`${c.weekday},${c.hour}`, c]));

  function binned(weekday: number, binIdx: number): { activeDays: number; costUsd: number | null; hours: number[] } {
    let activeDays = 0;
    let costSum = 0;
    let anyCost = false;
    const hours: number[] = [];
    for (let h = binIdx * binSize; h < binIdx * binSize + binSize; h++) {
      const c = cellAt.get(`${weekday},${h}`);
      hours.push(h);
      if (c) {
        activeDays = Math.max(activeDays, c.activeDays);
        if (c.costUsd != null) {
          costSum += c.costUsd;
          anyCost = true;
        }
      }
    }
    return { activeDays, costUsd: anyCost ? costSum : 0, hours };
  }

  const allValues: number[] = [];
  for (let w = 0; w < 7; w++)
    for (let b = 0; b < cols; b++) {
      const cell = binned(w, b);
      const v = metric === "hours" ? cell.activeDays : cell.costUsd ?? 0;
      if (v > 0) allValues.push(v);
    }
  const edges = quantileEdges(allValues, 5);

  const cells: HeatCellData[] = [];
  for (let w = 0; w < 7; w++) {
    for (let b = 0; b < cols; b++) {
      const cell = binned(w, b);
      const v = metric === "hours" ? cell.activeDays : cell.costUsd ?? 0;
      const label = binSize === 1 ? `${String(cell.hours[0]).padStart(2, "0")}:00` : `${String(cell.hours[0]).padStart(2, "0")}-${String(cell.hours[cell.hours.length - 1] + 1).padStart(2, "0")}h`;
      cells.push({
        row: w,
        col: b,
        key: `${w}-${b}`,
        colorVar: v > 0 ? SEQ_VARS[binOf(v, edges)] : null,
        ariaLabel: `${WEEKDAYS[w]} ${label}: active on ${cell.activeDays} of ${data.weekdayCounts[w]} ${WEEKDAYS[w]}s, ${formatUsd(cell.costUsd)} spend`,
        tooltip: (
          <div className="space-y-1">
            <div className="font-medium text-ink">
              {WEEKDAYS[w]} {label}
            </div>
            <TooltipRow label="active" value={`${cell.activeDays} of ${data.weekdayCounts[w]} ${WEEKDAYS[w]}s`} />
            <TooltipRow label="spend" value={formatUsd(cell.costUsd)} />
          </div>
        ),
      });
    }
  }

  const weekdaySpend = WEEKDAYS.map((_, w) => data.weekHour.filter((c) => c.weekday === w).reduce((s, c) => s + (c.costUsd ?? 0), 0));
  const maxWeekdaySpend = Math.max(1, ...weekdaySpend);

  const table = (
    <DataTable
      caption="Weekly rhythm: active-day counts by weekday and hour, plus spend per weekday"
      rowKey={(w) => String(w)}
      rows={[0, 1, 2, 3, 4, 5, 6]}
      columns={[
        { key: "weekday", label: "Weekday", render: (w) => WEEKDAYS[w] },
        ...Array.from({ length: 24 }, (_, h) => ({
          key: `h${h}`,
          label: String(h),
          numeric: true,
          render: (w: number) => String(cellAt.get(`${w},${h}`)?.activeDays ?? 0),
        })),
        { key: "spend", label: "Spend", numeric: true, render: (w: number) => formatUsd(weekdaySpend[w]) },
      ]}
    />
  );

  return (
    <ChartCard
      title="Weekly rhythm"
      subtitle="Which hours and weekdays are busy? (counts active hours, not messages)"
      legend={<ScaleLegend edges={edges} format={(v) => (metric === "hours" ? `${Math.round(v)} days` : formatUsd(v))} />}
      height={7 * (cellSize + 2) + (24 + 14) * scale}
      loading={loading}
      refetching={refetching}
      view={view}
      onViewChange={setView}
      table={table}
      right={
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: "hours", label: "Active hours" },
            { value: "spend", label: "Spend" },
          ]}
        />
      }
    >
      <div ref={ref} className="flex h-full flex-col justify-center gap-1">
        {/* Hour ticks every 3h (spec §6, C10) -- offset to sit directly over
            the grid columns, past the weekday-label column, using the SAME
            scaled label/gap constants as the row below so the ticks never
            drift off their columns at a text size other than the default
            (reviewer finding). */}
        {/* overflow-visible: at a large scaled text size, a glyph centred on
            row 0 (or this tick row's own baseline) can extend a px or two
            past the SVG's own declared box, which SVG clips by default --
            same 1px-clip family as the calendar's row labels (reviewer
            finding, O5). */}
        <svg width="100%" height={14 * scale} className="shrink-0 overflow-visible">
          {Array.from({ length: cols }, (_, b) => b)
            .filter((b) => (b * binSize) % 3 === 0)
            .map((b) => (
              <text key={b} x={labelColW + rowGap + b * (cellSize + 2) + cellSize / 2} y={10 * scale} textAnchor="middle" className={TICK_CLASS}>
                {String(b * binSize).padStart(2, "0")}
              </text>
            ))}
          {/* the spend sparkbar column's own header (§6, B12: it had no label
              at all, categorical among otherwise-labelled marks) -- gated
              behind the SAME breakpoint as the sparkbar SVG itself
              (`hidden sm:block` below), not drawn unconditionally: below
              `sm` the sparkbar column doesn't render at all, so this used to
              sit above an empty column (or, past this tick SVG's own width,
              get clipped to a lone "S") (reviewer finding, R6). */}
          {!narrow && (
            <text x={labelColW + rowGap + cols * (cellSize + 2) + rowGap} y={10 * scale} className={TICK_CLASS}>
              Spend
            </text>
          )}
        </svg>
        {/* `style={{ gap }}` (px, scaled), not the `gap-3` rem class the tick
            math above used to assume: the two used to drift apart at any text
            size other than 16 (reviewer finding, A10). */}
        <div className="flex flex-1" style={{ gap: rowGap }}>
          <svg width={labelColW} height={7 * (cellSize + 2)} className="shrink-0 overflow-visible">
            {WEEKDAYS.map((d, i) => (
              <text key={d} x={0} y={i * (cellSize + 2) + cellSize / 2} dominantBaseline="central" className={TICK_CLASS}>
                {d}
              </text>
            ))}
          </svg>
          <HeatGrid cells={cells} cols={cols} rows={7} cellSize={cellSize} gap={2} />
          <svg width={sparkbarColW} height={7 * (cellSize + 2)} className="hidden shrink-0 overflow-visible sm:block">
            {weekdaySpend.map((v, i) => {
              const w = Math.max(1, (v / maxWeekdaySpend) * SPARKBAR_MAX_W * scale);
              return (
                <g key={i}>
                  <rect x={0} y={i * (cellSize + 2) + cellSize / 2 - 3 * scale} width={w} height={6 * scale} fill="var(--viz-s1)" rx={1} />
                  <text x={w + 4 * scale} y={i * (cellSize + 2) + cellSize / 2} dominantBaseline="central" className={TICK_CLASS}>
                    {compactUsd(v)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </ChartCard>
  );
}
