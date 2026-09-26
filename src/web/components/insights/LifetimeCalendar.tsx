import { useState, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatUsdWhole, formatDay } from "../../cost.ts";
import { calendarLayout, ymd } from "../../insights.ts";
import { quantileEdges, binOf } from "../charts/scales.ts";
import { SEQ_VARS } from "../charts/palette.ts";
import { HeatGrid, type HeatCellData } from "../charts/HeatGrid.tsx";
import { ScaleLegend } from "../charts/ScaleLegend.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { TICK_CLASS } from "../charts/typography.ts";
import { useMediaQuery } from "../../useMediaQuery.ts";
import { useRootPx } from "../../useRootPx.ts";
import { Segmented } from "../primitives.tsx";

const ROW_LABEL_COL_W = 24;
const MONTH_ROW_H = 16;

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
  // The summary sits BESIDE the grid only from `lg` up (`lg:block` below) --
  // counting its height in the card's budget at every width reserved space
  // for a sidebar that isn't even rendered there, leaving a blank gap between
  // the grid and the stacked-below summary on phone/tablet (reviewer finding).
  const isLgSummary = useMediaQuery("(min-width: 1024px)");
  const rootPx = useRootPx();
  const scale = rootPx / 16;
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

  // The card's minimum body height has to fit whichever is taller: the grid,
  // or (at `lg` and up, where the summary sits BESIDE it rather than below)
  // the summary's own list, whose length depends on how many distinct months
  // have any activity. It's a FLOOR (ChartCard applies it as `min-height`,
  // never a fixed height), so rem text taller than this budget grows the card
  // instead of overflowing past its border (the reported bug), and the
  // `lg`-only summary no longer inflates the floor below `lg`, where it isn't
  // even rendered (reviewer finding: ~94px of dead space above the
  // stacked-below summary).
  const gridH = MONTH_ROW_H * scale + 7 * (cellSize + 2);
  const summaryRows = monthlyActiveDays.size + 3; // + mean/longest/current
  const summaryH = (20 + summaryRows * 18) * scale;
  // No added padding: below `lg` the stacked-below summary already carries
  // its own `mt-4` top margin, so a flat `+24` here just doubled up as dead
  // space between the grid and that summary (~33px at 390/22, on top of the
  // margin) -- exactly the calendar-body slack the reviewer flagged
  // (finding, O5). At `lg`, sizing to the exact taller-of-the-two leaves no
  // less room than the content actually needs either.
  const cardH = isLgSummary ? Math.max(gridH, summaryH) : gridH;

  // Two explicit groups -- the Active-days list, then a stats stack -- each
  // with its own consistent internal row gap (`space-y-0.5`), and section
  // spacing only BETWEEN the groups (applied by each wrapper below). The old
  // single flat list of four heterogeneous rows under one uniform
  // `space-y-2` gave month rows and stat rows two different rhythms (reviewer
  // finding), and below `lg` its `grid-cols-2` auto-placement zig-zagged
  // reading order (Active days / Mean on row 1, the two streaks on row 2)
  // instead of one list per column -- exactly two top-level children here
  // makes that a non-issue.
  // `items-baseline` + a truncating label + a `shrink-0 whitespace-nowrap`
  // value, not two free-wrapping flex children -- at a narrow stacked-below
  // width, a long label ("Longest streak") used to wrap onto its own second
  // line while its value drifted onto whatever row happened to be next
  // ("Longest / streak" beside "21 / days"), the same "text escaping its own
  // row" family as the reported bug (reviewer finding, O5).
  const summaryContent = (
    <>
      <div className="space-y-0.5">
        <div className="mb-1 font-semibold text-ink-4">Active days</div>
        {[...monthlyActiveDays.entries()].map(([m, n]) => (
          <div key={m} className="flex items-baseline justify-between gap-2">
            <span className="truncate">{MONTH_NAMES[Number(m.slice(5, 7)) - 1]}</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums">{n}</span>
          </div>
        ))}
      </div>
      <div className="space-y-0.5 border-t border-border-weak pt-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate">Mean / active day</span>
          {/* A standalone summary figure, not a table cell -- formatUsdWhole,
             matching the hero/KPI/records convention (§5, reviewer finding
             B9), not the exact-cents `formatUsd` this used to call. */}
          <span className="shrink-0 whitespace-nowrap tabular-nums">{meanPerActiveDay != null ? formatUsdWhole(meanPerActiveDay) : "-"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate">Longest streak</span>
          {/* "N days", matching the records strip's own streak unit -- not
             the abbreviated "Nd" this used to read, one of two spellings for
             the same unit on the same page (reviewer finding, B17). */}
          <span className="shrink-0 whitespace-nowrap tabular-nums">{data.records.longestStreak?.days ?? 0} days</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate">Current streak</span>
          <span className="shrink-0 whitespace-nowrap tabular-nums">{data.records.currentStreakDays} days</span>
        </div>
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
        // grid-cols-1 below `sm`, not a flat 2 -- at phone width a 2-column
        // layout gave each column too little room for its own label/value
        // pair, which is what wrapped them onto mismatched rows in the first
        // place (reviewer finding, O5).
        <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 text-2xs text-ink-3 sm:grid-cols-2 lg:hidden">{summaryContent}</div>
      }
    >
      <div className="flex h-full gap-6" id={id}>
        <div ref={gridBoxRef} className="flex min-w-0 flex-1 gap-2">
          {/* Row labels live OUTSIDE the horizontal scroller (the marginTop
              aligns them under the month-label row, in the SAME px units as
              that row's own height -- not the `mt-4` rem margin this used to
              be, which drifted out of step with it at any text size other
              than the default 16, per the reviewer's pixel-picky finding)
              -- inside the scroller, they used to scroll away with the grid
              at narrow widths, and their old fixed-9px, 16px-wide box clipped
              "Mon"/"Wed"/"Fri" to illegible fragments at larger text sizes. */}
          <svg
            width={ROW_LABEL_COL_W * scale}
            height={7 * (cellSize + 2)}
            style={{ marginTop: MONTH_ROW_H * scale }}
            className="shrink-0 overflow-visible"
          >
            {["Mon", "", "Wed", "", "Fri", "", ""].map((l, i) =>
              l ? (
                <text key={i} x={0} y={i * (cellSize + 2) + cellSize / 2} dominantBaseline="central" className={TICK_CLASS}>
                  {l}
                </text>
              ) : null
            )}
          </svg>
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
            <div style={{ width: weeks * (cellSize + 2) }}>
              <svg width={weeks * (cellSize + 2)} height={MONTH_ROW_H * scale} className="block overflow-visible">
                {monthLabels.map((m) => (
                  <text key={m.col} x={m.col * (cellSize + 2)} y={MONTH_ROW_H * scale * 0.75} className={TICK_CLASS}>
                    {m.label}
                  </text>
                ))}
              </svg>
              <HeatGrid cells={cells} cols={weeks} rows={7} cellSize={cellSize} gap={2} />
            </div>
          </div>
        </div>
        <div className="hidden w-40 shrink-0 space-y-3 text-2xs text-ink-3 lg:block">{summaryContent}</div>
      </div>
    </ChartCard>
  );
}
