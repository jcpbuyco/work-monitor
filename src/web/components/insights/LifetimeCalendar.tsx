import { useState, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatDay } from "../../cost.ts";
import { calendarLayout, ymd } from "../../insights.ts";
import { quantileEdges, binOf } from "../charts/scales.ts";
import { SEQ_VARS } from "../charts/palette.ts";
import { HeatGrid, type HeatCellData } from "../charts/HeatGrid.tsx";
import { ScaleLegend } from "../charts/ScaleLegend.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useMediaQuery } from "../../useMediaQuery.ts";
import { Segmented } from "../primitives.tsx";

type Metric = "spend" | "messages";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function LifetimeCalendar({
  data,
  ringedDay,
  id,
  loading,
  refetching,
}: {
  data: InsightsResponse;
  ringedDay: string | null;
  id?: string;
  loading?: boolean;
  refetching?: boolean;
}) {
  const [metric, setMetric] = useState<Metric>("spend");
  const [view, setView] = useChartView();
  const isPhone = useMediaQuery("(max-width: 390px)");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [gridBoxRef, gridBoxWidth] = useChartWidth<HTMLDivElement>();

  const firstDay = data.meta.firstAt != null ? ymd(new Date(data.meta.firstAt)) : null;
  const today = ymd(new Date());
  const byDay = useMemo(() => new Map(data.days.map((d) => [d.day, d])), [data.days]);
  const layout = useMemo(() => (firstDay ? calendarLayout(firstDay, today) : []), [firstDay, today]);
  const values = data.days.map((d) => (metric === "spend" ? d.costUsd ?? 0 : d.messages)).filter((v) => v > 0);
  const edges = quantileEdges(values, 5);
  const weeks = layout.length ? Math.max(...layout.map((c) => c.week)) + 1 : 0;
  // Cells grow to fill the card (a fixed 14px grid left half of a wide card
  // empty) but never past 24px, and never below the old fixed size, so a
  // phone still scrolls horizontally instead of shrinking cells illegibly.
  const minCell = isPhone ? 12 : 14;
  const cellSize = weeks ? Math.max(minCell, Math.min(24, Math.floor(gridBoxWidth / weeks) - 2)) : minCell;

  // Anchor to the latest week (§4, phone layout). A single mount-time
  // assignment isn't enough: at 390px the summary sidebar is hidden and the
  // web font can still be swapping in, either of which can shift this
  // scroller's own size a moment after first paint and leave `scrollLeft`
  // stuck short of the true end (finding: measured 140/204px on a real
  // reload). `useLayoutEffect` re-pins before the browser paints, and the
  // ResizeObserver keeps re-pinning through any later shift, not just the
  // first one.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      el.scrollLeft = el.scrollWidth;
    };
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);

  const cells: HeatCellData[] = layout.map((c) => {
    const d = byDay.get(c.day);
    const val = d ? (metric === "spend" ? d.costUsd ?? 0 : d.messages) : 0;
    const colorVar = d && val > 0 ? SEQ_VARS[binOf(val, edges)] : null;
    return {
      row: c.weekday,
      col: c.week,
      key: c.day,
      colorVar,
      ring: c.day === ringedDay,
      ariaLabel: d ? `${formatDay(c.day)}: ${formatUsd(d.costUsd)}, ${d.messages} messages` : `${formatDay(c.day)}: no activity`,
      tooltip: (
        <div className="space-y-1">
          <div className="font-medium text-ink">{formatDay(c.day)}</div>
          {d ? (
            <>
              <TooltipRow label="spend" value={formatUsd(d.costUsd)} />
              <TooltipRow label="messages" value={d.messages.toLocaleString()} />
              <TooltipRow label="sessions" value={String(d.sessions)} />
              <TooltipRow label="top project" value={d.topProject ?? "-"} />
            </>
          ) : (
            <div className="text-ink-3">No activity</div>
          )}
        </div>
      ),
    };
  });

  // Month labels along the top: one per week-column whose first row (Monday)
  // starts a new calendar month relative to the previous labelled column.
  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = "";
  for (let w = 0; w < weeks; w++) {
    const firstOfWeek = layout.find((c) => c.week === w && c.weekday === 0) ?? layout.find((c) => c.week === w);
    if (!firstOfWeek) continue;
    const month = firstOfWeek.day.slice(0, 7);
    if (month !== lastMonth) {
      monthLabels.push({ col: w, label: MONTH_NAMES[Number(month.slice(5, 7)) - 1] });
      lastMonth = month;
    }
  }

  const monthlyActiveDays = new Map<string, number>();
  for (const d of data.days) monthlyActiveDays.set(d.day.slice(0, 7), (monthlyActiveDays.get(d.day.slice(0, 7)) ?? 0) + 1);
  const pricedDays = data.days.filter((d) => d.costUsd != null);
  const meanPerActiveDay = pricedDays.length ? pricedDays.reduce((s, d) => s + (d.costUsd ?? 0), 0) / pricedDays.length : null;

  // The card's fixed body height has to fit whichever is taller: the grid, or
  // (at `lg` and up, where the summary sits BESIDE it rather than below) the
  // summary's own list, whose length depends on how many distinct months
  // have any activity -- a hardcoded height overflowed the card's bottom
  // edge once there were enough months to list (reviewer finding: "Current
  // streak" sitting outside the border).
  const gridH = 16 + 7 * (cellSize + 2);
  const summaryRows = monthlyActiveDays.size + 3; // + mean/longest/current
  const summaryH = 20 + summaryRows * 18;
  const cardH = Math.max(gridH, summaryH) + 24;

  const summaryContent = (
    <>
      <div>
        <div className="mb-1 font-semibold text-ink-4">Active days</div>
        {[...monthlyActiveDays.entries()].map(([m, n]) => (
          <div key={m} className="flex justify-between">
            <span>{MONTH_NAMES[Number(m.slice(5, 7)) - 1]}</span>
            <span className="tabular-nums">{n}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between border-t border-border-weak pt-1">
        <span>Mean / active day</span>
        <span className="tabular-nums">{meanPerActiveDay != null ? formatUsd(meanPerActiveDay) : "-"}</span>
      </div>
      <div className="flex justify-between">
        <span>Longest streak</span>
        <span className="tabular-nums">{data.records.longestStreak?.days ?? 0}d</span>
      </div>
      <div className="flex justify-between">
        <span>Current streak</span>
        <span className="tabular-nums">{data.records.currentStreakDays}d</span>
      </div>
    </>
  );

  const table = (
    <DataTable
      caption="Active days, newest first"
      rowKey={(d) => d.day}
      rows={[...data.days].sort((a, b) => b.day.localeCompare(a.day))}
      columns={[
        { key: "day", label: "Date", render: (d) => formatDay(d.day) },
        { key: "spend", label: "Spend", numeric: true, render: (d) => formatUsd(d.costUsd) },
        { key: "messages", label: "Messages", numeric: true, render: (d) => d.messages.toLocaleString() },
        { key: "sessions", label: "Sessions", numeric: true, render: (d) => String(d.sessions) },
        { key: "project", label: "Top project", render: (d) => d.topProject ?? "-" },
      ]}
    />
  );

  return (
    <ChartCard
      title="Lifetime calendar"
      subtitle="When have you been working, and how intense was each day?"
      legend={<ScaleLegend edges={edges} format={(v) => (metric === "spend" ? formatUsd(v) : Math.round(v).toLocaleString())} />}
      height={cardH}
      loading={loading}
      refetching={refetching}
      empty={layout.length === 0}
      view={view}
      onViewChange={setView}
      table={table}
      right={
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: "spend", label: "Spend" },
            { value: "messages", label: "Messages" },
          ]}
        />
      }
      below={
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-ink-3 lg:hidden">{summaryContent}</div>
      }
    >
      <div className="flex h-full gap-6" id={id}>
        <div ref={gridBoxRef} className="flex min-w-0 flex-1 gap-2">
          {/* Row labels live OUTSIDE the horizontal scroller (pt-4 aligns
              them under the 16px month-label row) -- inside it, they used to
              scroll away with the grid at narrow widths (reviewer finding),
              and their old 16px-wide box clipped "Mon"/"Wed"/"Fri" to
              illegible fragments even when visible. */}
          <svg width={24} height={7 * (cellSize + 2)} className="mt-4 shrink-0">
            {["Mon", "", "Wed", "", "Fri", "", ""].map((l, i) =>
              l ? (
                <text key={i} x={0} y={i * (cellSize + 2) + cellSize - 2} className="fill-ink-4 text-[9px]">
                  {l}
                </text>
              ) : null
            )}
          </svg>
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
            <div style={{ width: weeks * (cellSize + 2) }}>
              <svg width={weeks * (cellSize + 2)} height={16} className="block">
                {monthLabels.map((m) => (
                  <text key={m.col} x={m.col * (cellSize + 2)} y={12} className="fill-ink-4 text-[10px]">
                    {m.label}
                  </text>
                ))}
              </svg>
              <HeatGrid cells={cells} cols={weeks} rows={7} cellSize={cellSize} gap={2} />
            </div>
          </div>
        </div>
        <div className="hidden w-40 shrink-0 space-y-2 text-2xs text-ink-3 lg:block">{summaryContent}</div>
      </div>
    </ChartCard>
  );
}
