import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd } from "../../cost.ts";
import { compactUsd, formatMonth } from "../charts/format.ts";
import { StepLines } from "../charts/StepLines.tsx";
import { Legend } from "../charts/Legend.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { useRootPx } from "../../useRootPx.ts";
import { cumulativeWithCarry, daysInMonth } from "../../insights.ts";

const PLOT_H = 240;
const AXIS_BAND = 24;

/** C4: cumulative spend by day of month, this month in the accent against up
 *  to 3 earlier months in gray, plus a dashed trailing-7-day-rate projection. */
export function MonthPace({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [view, setView] = useChartView();
  const [ref, width, height] = useChartWidth<HTMLDivElement>();
  const rootPx = useRootPx();
  const scale = rootPx / 16;
  const axisBand = AXIS_BAND * scale;
  // A taller paired sibling (Monthly spend by model, sharing this `lg:grid`
  // row) can stretch this card's body well past its own natural height --
  // a fixed `plotHeight={240}` left that extra room as dead space below the
  // axis instead of growing into it (reviewer finding, O3). `height` is this
  // component's own flex-stretched wrapper, so the plot grows to fill it.
  const plotHeight = Math.max(PLOT_H * scale, height - axisBand);

  const withUsage = data.months.filter((m) => data.days.some((d) => d.day.startsWith(m)));
  const current = data.currentMonth;
  const earlier = withUsage.filter((m) => m !== current).slice(-3);
  const shown = [...earlier, ...(withUsage.includes(current) ? [current] : [])];

  const now = new Date();
  const todayIndex = now.getDate() - 1;

  const series = shown.map((month) => {
    const len = daysInMonth(month);
    const isCurrent = month === current;
    const cap = isCurrent ? todayIndex : undefined;
    // formatMonth(..., {current}), not a bare month name: the current month's
    // end label and table column used to both read "Sep" -- identical to a
    // fully-elapsed earlier month's label with no "still filling in" signal,
    // while every other month reference on the page (the x axis right below
    // it, the calendar summary) already says "Sep MTD" (reviewer finding,
    // B17).
    return {
      month,
      label: `${formatMonth(month, { current })} ${compactUsd(lastValue(cumulativeWithCarry(data.days, month, len, cap)))}`,
      shortLabel: formatMonth(month, { current }),
      values: cumulativeWithCarry(data.days, month, len, cap),
      emphasis: isCurrent,
    };
  });

  const currentSeries = series.find((s) => s.emphasis);
  const projectionTo = data.kpi.projectedMonthEndUsd;

  const table = (
    <DataTable
      caption="Cumulative spend by day of month"
      rowKey={(d) => String(d)}
      rows={Array.from({ length: 31 }, (_, i) => i + 1)}
      columns={[
        { key: "day", label: "Day", render: (d) => String(d) },
        ...series.map((s) => ({
          key: s.month,
          label: formatMonth(s.month, { current }),
          numeric: true,
          // Exact, grouped `formatUsd` (§5/B9/B18): a table shows precise
          // numbers, not the chart's own rounded "$1.9k" -- this was the one
          // table on the page using its chart's compact form, and a day
          // outside the month/before "today" reads "-" (no row exists), never
          // a blank cell that looks like a rendering gap.
          render: (d: number) => {
            const v = s.values[d - 1];
            return v == null ? "-" : formatUsd(v);
          },
        })),
      ]}
    />
  );

  return (
    <ChartCard
      title="Month pace"
      // A metric subtitle (§5's own convention for every other card), not the
      // colour key spelled out in words -- that was the one subtitle on the
      // page describing its OWN legend instead of the metric, now that the
      // colour key has an actual `Legend` beneath it like every other
      // multi-series chart (reviewer finding, O7).
      subtitle="Cumulative spend by day of month"
      legend={
        <Legend
          entries={[
            { id: "current", label: currentSeries ? currentSeries.shortLabel ?? currentSeries.label : "This month", color: "var(--viz-s1)", kind: "line" },
            { id: "earlier", label: "Earlier months", color: "var(--viz-context)", kind: "line" },
          ]}
        />
      }
      height={Math.round(PLOT_H * scale + axisBand)}
      loading={loading}
      refetching={refetching}
      empty={series.length === 0}
      view={view}
      onViewChange={setView}
      table={table}
    >
      <div ref={ref} className="h-full">
        <StepLines
          series={series}
          width={width}
          plotHeight={plotHeight}
          axisBand={axisBand}
          todayIndex={currentSeries ? todayIndex : undefined}
          projectionTo={currentSeries ? projectionTo ?? undefined : undefined}
          projectionLabel={projectionTo != null ? `~${compactUsd(projectionTo)}` : undefined}
          monthLength={currentSeries ? daysInMonth(current) : undefined}
          formatValue={(v) => compactUsd(v)}
        />
      </div>
    </ChartCard>
  );
}

function lastValue(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]!;
  return 0;
}
