import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd } from "../../cost.ts";
import { compactUsd, formatMonth, orDash } from "../charts/format.ts";
import { band, linear, niceTicks } from "../charts/scales.ts";
import { YAxis, yAxisGutter, thinBandLabels } from "../charts/Axis.tsx";
import { useTooltip } from "../charts/useTooltip.ts";
import { Tooltip, TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { useRootPx } from "../../useRootPx.ts";
import { VALUE_CLASS, TICK_PX_AT_16, LABEL_HALO, scaleOf } from "../charts/typography.ts";

const MIN_ACTIVE_HOURS = 10;
const PANEL_H = 96;

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${w - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} Z`;
}

function Panel({
  title,
  months,
  values,
  width,
  formatValue,
  formatAxis,
  currentMonth,
  tooltipFor,
}: {
  title: string;
  months: string[];
  values: (number | null)[];
  width: number;
  formatValue: (v: number) => string;
  formatAxis?: (v: number) => string;
  currentMonth: string;
  tooltipFor: (i: number) => React.ReactNode;
}) {
  const tooltip = useTooltip();
  const rootPx = useRootPx();
  const scale = scaleOf(rootPx);
  const panelH = PANEL_H * scale;
  const max = Math.max(1, ...values.filter((v): v is number => v != null));
  const ticks = niceTicks(max, 3);
  const niceMax = ticks[ticks.length - 1];
  // 18% headroom above the tallest tick -- not just the axis's own top-tick
  // padding, real room for a cap label to sit ABOVE even the tallest bar,
  // every time. A near-max bar used to leave its label with nowhere to go
  // but INSIDE the bar's own fill (white-on-blue) as the one exception to
  // "labels sit above their mark" (reviewer finding, B16).
  const scaleY = linear([0, niceMax * 1.18], [panelH, 0]);
  const gutter = yAxisGutter(ticks, formatAxis ?? formatValue, rootPx);
  const { at, step, bandwidth } = band(months, [gutter, width], 0.4);
  const barW = Math.min(24 * scale, bandwidth);
  const currentIndex = months.indexOf(currentMonth);
  // Same collision-thinning `StackedColumns` uses for its own x-axis month
  // labels (§R4): this panel draws an identical band x axis but, being a
  // separate component, had none of that handling -- "Aug"/"Sep MTD" (and
  // other adjacent short/long pairs) garbled together once text scaled up on
  // a narrow card (reviewer finding, R4, "Active hours" panels).
  const xLabels = thinBandLabels(months.map((m) => formatMonth(m, { current: currentMonth })), currentIndex, step, TICK_PX_AT_16 * scale, scale);
  return (
    <div className="relative">
      <p className="mb-2 text-3xs uppercase tracking-caps text-ink-4">{title}</p>
      <svg width={width} height={panelH + 20 * scale} className="overflow-visible">
        <YAxis ticks={ticks} y={scaleY} width={width} format={formatAxis ?? formatValue} x0={gutter} />
        {/* A month with too little data draws NO bar at all -- the in-chart
            "-" placeholder this used to draw duplicated what the Table view
            already shows for the same month, and read as a fifth, unlabelled
            mark among the real bars (reviewer finding, B16). */}
        {months.map((m, i) => {
          const v = values[i];
          if (v == null) return null;
          const x = at(m) + (bandwidth - barW) / 2;
          const h = scaleY(0) - scaleY(v);
          return (
            <g
              key={m}
              tabIndex={0}
              role="img"
              aria-label={`${formatMonth(m, { current: currentMonth })}: ${formatValue(v)}`}
              onMouseEnter={(e) => tooltip.showFromEvent(e, tooltipFor(i))}
              onMouseMove={(e) => tooltip.showFromEvent(e, tooltipFor(i))}
              onMouseLeave={tooltip.hide}
              onFocus={(e) => tooltip.showFromElement(e.currentTarget, tooltipFor(i))}
              onBlur={tooltip.hide}
            >
              <path d={roundedTopRect(x, panelH - h, barW, h, 4)} fill="var(--viz-s1)" />
              <text x={x + barW / 2} y={panelH - h - 6 * scale} textAnchor="middle" className={VALUE_CLASS} style={LABEL_HALO}>
                {formatValue(v)}
              </text>
            </g>
          );
        })}
        {months.map(
          (m, i) =>
            xLabels[i] != null && (
              <text
                key={`x-${m}`}
                x={at(m) + bandwidth / 2}
                y={panelH + 14 * scale}
                textAnchor="middle"
                className={`text-3xs ${m === currentMonth ? "fill-ink-2 font-medium" : "fill-ink-4"}`}
                style={LABEL_HALO}
              >
                {xLabels[i]}
              </text>
            )
        )}
      </svg>
      <Tooltip state={tooltip.state} />
    </div>
  );
}

/** C11: two aligned single-series panels sharing one month x axis (never a
 *  dual axis) -- active main-session hours on top, $ per active hour below. */
export function Leverage({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [view, setView] = useChartView();
  const [ref, width] = useChartWidth<HTMLDivElement>();

  const activityByMonth = new Map(data.activity.map((a) => [a.month, a.activeMs]));
  const spendByMonth = new Map<string, number | null>();
  // `hasRows`, tracked separately from the summed value: a month with real
  // usage rows that are all unpriced still HAD activity, so its Spend cell
  // reads "unpriced" (`formatUsd(null)`), while a month with no rows at all
  // reads "-" like every other empty cell in the same row (reviewer finding,
  // B18: "C11 hours '-' but spend '$0.00'" -- the old `rows.length === 0 ? 0`
  // branch gave an inactive month the same "$0.00" as a real zero-cost one).
  const monthHasRows = new Map<string, boolean>();
  for (const month of data.months) {
    const rows = data.byMonthModel.filter((r) => r.month === month);
    const priced = rows.filter((r) => r.costUsd != null);
    monthHasRows.set(month, rows.length > 0);
    spendByMonth.set(month, priced.length ? priced.reduce((s, r) => s + r.costUsd!, 0) : null);
  }

  const monthsWithEnough = data.months.filter((m) => (activityByMonth.get(m) ?? 0) / 3_600_000 >= MIN_ACTIVE_HOURS);
  const activeHours = data.months.map((m) => {
    const ms = activityByMonth.get(m) ?? 0;
    return ms / 3_600_000 >= MIN_ACTIVE_HOURS ? ms / 3_600_000 : null;
  });
  const perHour = data.months.map((m, i) => {
    const h = activeHours[i];
    const spend = spendByMonth.get(m);
    return h == null || spend == null ? null : spend / h;
  });

  const table = (
    <DataTable
      caption="Active hours and cost per active hour"
      rowKey={(m) => m}
      rows={data.months}
      columns={[
        { key: "month", label: "Month", render: (m) => formatMonth(m, { current: data.currentMonth, withYear: true }) },
        { key: "hours", label: "Active hours", numeric: true, render: (m) => (activeHours[data.months.indexOf(m)] != null ? activeHours[data.months.indexOf(m)]!.toFixed(0) : "-") },
        { key: "spend", label: "Spend", numeric: true, render: (m) => orDash(monthHasRows.get(m) ?? false, formatUsd(spendByMonth.get(m) ?? null)) },
        {
          key: "perHour",
          label: "$/active hour",
          numeric: true,
          render: (m) => {
            const v = perHour[data.months.indexOf(m)];
            return v == null ? "-" : formatUsd(v);
          },
        },
      ]}
    />
  );

  return (
    <ChartCard
      title="Active hours and cost per active hour"
      subtitle="active = main-session messages less than 30 min apart"
      height={2 * (PANEL_H + 20 + 20) + 24}
      loading={loading}
      refetching={refetching}
      empty={monthsWithEnough.length === 0}
      view={view}
      onViewChange={setView}
      table={table}
    >
      <div ref={ref} className="flex h-full flex-col gap-2">
        <Panel
          title="Active hours"
          months={data.months}
          values={activeHours}
          width={width}
          formatValue={(v) => `${v.toFixed(0)}h`}
          formatAxis={(v) => `${v}h`}
          currentMonth={data.currentMonth}
          tooltipFor={(i) => {
            const m = data.months[i];
            return (
              <div className="space-y-1">
                <div className="font-medium text-ink">{formatMonth(m, { current: data.currentMonth, withYear: true })}</div>
                <TooltipRow label="active hours" value={activeHours[i] != null ? `${activeHours[i]!.toFixed(0)}h` : "-"} />
                <TooltipRow label="spend" value={formatUsd(spendByMonth.get(m) ?? 0)} />
                <TooltipRow label="$/active hour" value={perHour[i] != null ? formatUsd(perHour[i]) : "-"} />
              </div>
            );
          }}
        />
        <Panel
          title="Cost per active hour"
          months={data.months}
          values={perHour}
          width={width}
          formatValue={(v) => compactUsd(v)}
          currentMonth={data.currentMonth}
          tooltipFor={(i) => {
            const m = data.months[i];
            return (
              <div className="space-y-1">
                <div className="font-medium text-ink">{formatMonth(m, { current: data.currentMonth, withYear: true })}</div>
                <TooltipRow label="$/active hour" value={perHour[i] != null ? formatUsd(perHour[i]) : "-"} />
              </div>
            );
          }}
        />
      </div>
    </ChartCard>
  );
}
