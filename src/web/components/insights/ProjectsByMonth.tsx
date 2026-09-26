import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd } from "../../cost.ts";
import { formatMonth } from "../charts/format.ts";
import { quantileEdges } from "../charts/scales.ts";
import { HeatTable, type HeatTableColumn } from "../charts/HeatTable.tsx";
import { ScaleLegend } from "../charts/ScaleLegend.tsx";
import { Tooltip, TooltipRow } from "../charts/Tooltip.tsx";
import { useTooltip } from "../charts/useTooltip.ts";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useIsDarkMode } from "../../useTheme.ts";

/** C12: a heat-shaded table of the top 10 projects by lifetime spend, plus a
 *  folded "Other" and "(no project)" -- 40 projects is well past the
 *  categorical color cap, so this card is a table by construction, not a
 *  chart with a table fallback. */
export function ProjectsByMonth({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [view, setView] = useChartView();
  const dark = useIsDarkMode();
  const tooltip = useTooltip();

  const monthsWithData = data.months.filter((m) => data.projects.some((p) => p.byMonth[m] != null));
  const rows = data.projects.map((p) => ({ ...p, key: p.project }));
  const monthTotalUsd = new Map<string, number>();
  for (const r of data.byMonthModel) monthTotalUsd.set(r.month, (monthTotalUsd.get(r.month) ?? 0) + (r.costUsd ?? 0));

  const columns: HeatTableColumn[] = [
    { key: "project", label: "Project" },
    ...monthsWithData.map((m) => ({ key: m, label: formatMonth(m, { current: data.currentMonth }) })),
    { key: "lifetime", label: "Lifetime" },
    // Sessions and Active days are counts, not dollars -- shading them with
    // the $ quantile edges below binned a "52 sessions" cell as if it were a
    // dollar amount (reviewer finding). Only the month $ columns carry the
    // heat ramp.
    { key: "sessions", label: "Sessions", shade: false },
    { key: "activeDays", label: "Active days", shade: false },
  ];

  const values = monthsWithData.flatMap((m) => data.projects.map((p) => p.byMonth[m]?.costUsd).filter((v): v is number => v != null && v > 0));
  const edges = values.length ? quantileEdges(values) : [0, 0, 0, 0, 0, 0];
  const maxLifetime = Math.max(1, ...data.projects.filter((p) => p.kind === "project").map((p) => p.lifetimeUsd ?? 0));

  const table = (
    <HeatTable
      columns={columns}
      rows={rows}
      shaded={view === "chart"}
      dark={dark}
      edges={edges}
      format={(v) => formatUsd(v)}
      defaultSort={{ key: "lifetime", dir: "desc" }}
      pinned={(p) => p.kind !== "project"}
      lifetimeBar={(p) => (p.lifetimeUsd ?? 0) / maxLifetime}
      cell={(p, key) => {
        if (key === "project") return { value: null, display: p.project };
        if (key === "lifetime") return { value: p.lifetimeUsd, display: formatUsd(p.lifetimeUsd) };
        if (key === "sessions") return { value: p.sessions, display: String(p.sessions) };
        if (key === "activeDays") return { value: p.activeDays, display: String(p.activeDays) };
        const m = p.byMonth[key];
        return { value: m?.costUsd ?? null, display: m ? formatUsd(m.costUsd) : "-" };
      }}
      onCellHover={(e, p, key) => {
        const m = p.byMonth[key];
        if (!m) return;
        const monthTotal = monthTotalUsd.get(key) ?? 0;
        const share = m.costUsd != null && monthTotal > 0 ? `${((m.costUsd / monthTotal) * 100).toFixed(0)}%` : "-";
        tooltip.showFromEvent(e, (
          <div className="space-y-1">
            <div className="font-medium text-ink">
              {p.project} · {formatMonth(key, { current: data.currentMonth, withYear: true })}
            </div>
            <TooltipRow label="spend" value={formatUsd(m.costUsd)} />
            <TooltipRow label="sessions" value={String(m.sessions)} />
            <TooltipRow label="share of month" value={share} />
          </div>
        ));
      }}
      onCellLeave={tooltip.hide}
    />
  );

  return (
    <>
      <ChartCard
        title="Projects by month"
        subtitle="Which projects consumed the budget, and when did each heat up and cool off?"
        legend={<ScaleLegend edges={edges} format={(v) => formatUsd(v)} />}
        // Header (32px) + one ~24px row per project/fold row -- the previous
        // 32px-per-row plus an 80px constant left 150-180px of empty space
        // below the actual table at 1280/1600 (reviewer finding), since a
        // `font-mono text-2xs` row with `py-1` padding renders shorter than
        // that.
        // Measured in a real browser: a 32px header plus ~25px per data row
        // (borders included) -- the previous 24px-per-row estimate was just
        // shy of that, clipping the very last row (reviewer finding, "Other"
        // or "(no project)" depending on the data).
        height={Math.min(480, 40 + rows.length * 25)}
        loading={loading}
        refetching={refetching}
        empty={rows.length === 0}
        view={view}
        onViewChange={setView}
        table={table}
      >
        <div className="h-full overflow-auto">{table}</div>
      </ChartCard>
      {/* Not inside ChartCard's `children`: that slot is unmounted in the
          Table-view branch (ChartCard renders the `table` prop instead), and
          this tooltip must show in either view. */}
      <Tooltip state={tooltip.state} />
    </>
  );
}
