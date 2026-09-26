import type { InsightsResponse } from "../../../shared/insights.ts";
import { compactUsd } from "../charts/format.ts";
import { StepLines } from "../charts/StepLines.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { cumulativeWithCarry, daysInMonth } from "../../insights.ts";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortMonth(m: string): string {
  return MONTH_NAMES[Number(m.split("-")[1]) - 1];
}

/** C4: cumulative spend by day of month, this month in the accent against up
 *  to 3 earlier months in gray, plus a dashed trailing-7-day-rate projection. */
export function MonthPace({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [view, setView] = useChartView();
  const [ref, width] = useChartWidth<HTMLDivElement>();

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
    return {
      month,
      label: `${shortMonth(month)} ${compactUsd(lastValue(cumulativeWithCarry(data.days, month, len, cap)))}`,
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
          label: shortMonth(s.month),
          numeric: true,
          render: (d: number) => {
            const v = s.values[d - 1];
            return v == null ? "" : compactUsd(v);
          },
        })),
      ]}
    />
  );

  return (
    <ChartCard
      title="Month pace"
      subtitle="Blue = this month, gray = earlier months"
      height={240 + 24}
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
          plotHeight={240}
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
