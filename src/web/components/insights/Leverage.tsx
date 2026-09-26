import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd } from "../../cost.ts";
import { compactUsd, formatMonth } from "../charts/format.ts";
import { band, linear, niceTicks } from "../charts/scales.ts";
import { YAxis } from "../charts/Axis.tsx";
import { useTooltip } from "../charts/useTooltip.ts";
import { Tooltip, TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";

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
  const max = Math.max(1, ...values.filter((v): v is number => v != null));
  const ticks = niceTicks(max, 3);
  const scaleY = linear([0, ticks[ticks.length - 1]], [PANEL_H, 0]);
  const { at, bandwidth } = band(months, [0, width], 0.4);
  const barW = Math.min(24, bandwidth);
  return (
    <div className="relative">
      {/* mb-2, not mb-0.5: a near-axis-max bar's cap label sits right at the
          plot's own y=0 (clamped, see below), so the title needs real
          breathing room above it or the two visually crowd together. */}
      <p className="mb-2 text-3xs uppercase tracking-caps text-ink-4">{title}</p>
      <svg width={width} height={PANEL_H + 20} className="overflow-visible">
        <YAxis ticks={ticks} y={scaleY} width={width} format={formatAxis ?? formatValue} />
        {months.map((m, i) => {
          const v = values[i];
          if (v == null) {
            return (
              <text key={m} x={at(m) + bandwidth / 2} y={PANEL_H - 4} textAnchor="middle" className="fill-ink-4 text-[10px]">
                -
              </text>
            );
          }
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
              <path d={roundedTopRect(x, PANEL_H - h, barW, h, 4)} fill="var(--viz-s1)" />
              {/* A bar within 14px of the panel's own top has no room for a
                  cap label above it at all -- clamping the y alone (still
                  needed so the label never floats above the SVG into the
                  OTHER panel's row, per the reviewer's original finding) just
                  moved the collision from "the row above" to "the bar's own
                  fill", with dark-on-blue text sitting half inside the bar's
                  rounded top. Past that point the label moves INSIDE the bar
                  instead, in white, like every other bar chart on this page
                  does for a segment too short to label above. */}
              {PANEL_H - h < 14 ? (
                <text x={x + barW / 2} y={PANEL_H - h + 12} textAnchor="middle" className="fill-white text-[10px] tabular-nums font-medium">
                  {formatValue(v)}
                </text>
              ) : (
                <text x={x + barW / 2} y={PANEL_H - h - 6} textAnchor="middle" className="fill-ink-2 text-[10px] tabular-nums font-medium">
                  {formatValue(v)}
                </text>
              )}
            </g>
          );
        })}
        {months.map((m, i) => (
          <text
            key={`x-${m}`}
            x={at(m) + bandwidth / 2}
            y={PANEL_H + 14}
            textAnchor="middle"
            className={`text-[10px] ${m === currentMonth ? "fill-ink-2 font-medium" : "fill-ink-4"}`}
          >
            {formatMonth(m, { current: currentMonth })}
          </text>
        ))}
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
  for (const month of data.months) {
    const rows = data.byMonthModel.filter((r) => r.month === month);
    const priced = rows.filter((r) => r.costUsd != null);
    spendByMonth.set(month, rows.length === 0 ? 0 : priced.length ? priced.reduce((s, r) => s + r.costUsd!, 0) : null);
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
        { key: "spend", label: "Spend", numeric: true, render: (m) => formatUsd(spendByMonth.get(m) ?? 0) },
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
