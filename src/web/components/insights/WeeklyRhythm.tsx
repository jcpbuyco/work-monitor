import { useState } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd } from "../../cost.ts";
import { quantileEdges, binOf } from "../charts/scales.ts";
import { SEQ_VARS } from "../charts/palette.ts";
import { HeatGrid, type HeatCellData } from "../charts/HeatGrid.tsx";
import { ScaleLegend } from "../charts/ScaleLegend.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { useMediaQuery } from "../../useMediaQuery.ts";
import { Segmented } from "../primitives.tsx";

type Metric = "hours" | "spend";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LABEL_COL_W = 20;
const SPARKBAR_COL_W = 40;
const ROW_GAP = 12; // Tailwind gap-3

/** C10: 7x24 heatmap of active hours or spend by weekday/hour, sharing C9's
 *  5-step ramp (one sequential language on the page). Below 640px, hours fold
 *  into 8 columns of 3. */
export function WeeklyRhythm({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [metric, setMetric] = useState<Metric>("hours");
  const [view, setView] = useChartView();
  const narrow = useMediaQuery("(max-width: 639px)");
  const [ref, measuredWidth] = useChartWidth<HTMLDivElement>();
  const binSize = narrow ? 3 : 1;
  const cols = 24 / binSize;
  // 24 hourly columns at a fixed 22px never fit the card body between about
  // 1024 and 1560px (24*(22+2) + the weekday-label column + the spend-
  // sparkbar column overflows a ~576px two-column card by roughly 80px --
  // reviewer finding, blue bars spilling into C11's card). Shrinking the cell
  // pitch to the ACTUAL measured width keeps every column visible with no
  // page or nested-card overflow, only ever shrinking from the 22px ideal,
  // never growing past it.
  const desktopCellSize = Math.max(14, Math.min(22, Math.floor((measuredWidth - LABEL_COL_W - SPARKBAR_COL_W - 2 * ROW_GAP) / cols) - 2));
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
      height={7 * (cellSize + 2) + 24 + 14}
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
      <div ref={ref} className="flex h-full flex-col gap-1">
        {/* Hour ticks every 3h (spec §6, C10) -- offset to sit directly over
            the grid columns, past the weekday-label column. */}
        <svg width="100%" height={14} className="shrink-0">
          {Array.from({ length: cols }, (_, b) => b)
            .filter((b) => (b * binSize) % 3 === 0)
            .map((b) => (
              <text
                key={b}
                x={LABEL_COL_W + ROW_GAP + b * (cellSize + 2) + cellSize / 2}
                y={10}
                textAnchor="middle"
                className="fill-ink-4 text-[9px] tabular-nums"
              >
                {String(b * binSize).padStart(2, "0")}
              </text>
            ))}
        </svg>
        <div className="flex flex-1 gap-3">
          <svg width={LABEL_COL_W} height={7 * (cellSize + 2)} className="shrink-0">
            {WEEKDAYS.map((d, i) => (
              <text key={d} x={0} y={i * (cellSize + 2) + cellSize / 2 + 4} className="fill-ink-4 text-[10px]">
                {d}
              </text>
            ))}
          </svg>
          <HeatGrid cells={cells} cols={cols} rows={7} cellSize={cellSize} gap={2} />
          <svg width={SPARKBAR_COL_W} height={7 * (cellSize + 2)} className="hidden shrink-0 sm:block">
            {weekdaySpend.map((v, i) => (
              <rect key={i} x={0} y={i * (cellSize + 2) + cellSize / 2 - 3} width={Math.max(1, (v / maxWeekdaySpend) * 36)} height={6} fill="var(--viz-s1)" rx={1} />
            ))}
          </svg>
        </div>
      </div>
    </ChartCard>
  );
}
