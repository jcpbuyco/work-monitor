import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatDay } from "../../cost.ts";
import { ymd } from "../../insights.ts";
import { formatMonth } from "../charts/format.ts";
import { DotStrip } from "../charts/DotStrip.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "-";
  const h = ms / 3_600_000;
  return h >= 1 ? `${h.toFixed(1)}h` : `${(ms / 60_000).toFixed(0)}m`;
}

/** `formatDay`, not `toLocaleDateString()` -- the locale-dependent
 *  "9/14/2026" this used to print was the one date on the page not spelled
 *  "Sep 25" (reviewer finding, B14). */
function fmtDate(startedAt: number | null): string {
  return startedAt ? formatDay(ymd(new Date(startedAt))) : "-";
}

const OUTLIER_LABEL_MAX = 24;
function truncateLabel(name: string): string {
  return name.length > OUTLIER_LABEL_MAX ? `${name.slice(0, OUTLIER_LABEL_MAX - 1)}…` : name;
}

/** C7: one dot per workflow run, jittered within its month band on a log $
 *  axis, plus the monthly median and top-3 labelled outliers. */
export function WorkflowRunCosts({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [view, setView] = useChartView();
  const [ref, width] = useChartWidth<HTMLDivElement>();

  const runsWithMonth = data.workflowRuns.filter((r) => r.month != null);
  const withoutUsage = data.workflowRuns.filter((r) => r.costUsd == null).length;
  const monthsWithRuns = data.months.filter((m) => runsWithMonth.some((r) => r.month === m));
  const countByMonth = new Map<string, number>();
  const medianByMonth: Record<string, number | null> = {};
  for (const m of monthsWithRuns) {
    const vals = runsWithMonth.filter((r) => r.month === m && r.costUsd != null).map((r) => r.costUsd!);
    countByMonth.set(m, vals.length);
    medianByMonth[m] = median(vals);
  }
  const top3 = [...runsWithMonth].filter((r) => r.costUsd != null).sort((a, b) => b.costUsd! - a.costUsd!).slice(0, 3);
  const top3Ids = new Set(top3.map((r) => r.runId));

  const points = runsWithMonth
    .filter((r) => r.costUsd != null)
    .map((r) => ({
      id: r.runId,
      month: r.month!,
      value: r.costUsd!,
      // Truncated with an ellipsis, not a hard `.slice(0, 24)` with no
      // indication anything was cut -- and the full name lives in the dot's
      // own `fullLabel` (rendered as an SVG `<title>`, an on-hover fallback
      // for whoever doesn't reach the richer tooltip) (reviewer finding, A18).
      label: top3Ids.has(r.runId) ? truncateLabel(r.name ?? r.runId) : undefined,
      fullLabel: top3Ids.has(r.runId) ? r.name ?? r.runId : undefined,
      ariaLabel: `${r.name ?? r.runId}, ${fmtDate(r.startedAt)}: ${formatUsd(r.costUsd)}`,
      onClick: () => {
        window.location.hash = `#/workflows?run=${encodeURIComponent(r.runId)}`;
      },
      tooltip: (
        <div className="space-y-1">
          <div className="font-medium text-ink">{r.name ?? r.runId}</div>
          <TooltipRow label="date" value={fmtDate(r.startedAt)} />
          <TooltipRow label="status" value={r.status ?? "-"} />
          <TooltipRow label="agents" value={String(r.agentCount ?? "-")} />
          <TooltipRow label="duration" value={fmtDuration(r.durationMs)} />
          <TooltipRow label="cost" value={formatUsd(r.costUsd)} />
          <TooltipRow label="$/agent" value={r.agentCount ? formatUsd(r.costUsd! / r.agentCount) : "-"} />
        </div>
      ),
    }));

  const table = (
    <DataTable
      caption="Workflow run costs, sorted by cost descending"
      rowKey={(r) => r.runId}
      rows={[...data.workflowRuns].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1))}
      columns={[
        { key: "name", label: "Run", render: (r) => r.name ?? r.runId },
        { key: "date", label: "Date", render: (r) => fmtDate(r.startedAt) },
        { key: "status", label: "Status", render: (r) => r.status ?? "-" },
        { key: "agents", label: "Agents", numeric: true, render: (r) => String(r.agentCount ?? "-") },
        { key: "duration", label: "Duration", numeric: true, render: (r) => fmtDuration(r.durationMs) },
        { key: "cost", label: "Cost", numeric: true, render: (r) => formatUsd(r.costUsd) },
      ]}
    />
  );

  return (
    <ChartCard
      title="Workflow run costs"
      subtitle={`What a typical run costs, and which are outliers (${monthsWithRuns.map((m) => countByMonth.get(m)).join(" / ")} runs)`}
      height={240 + 24}
      loading={loading}
      refetching={refetching}
      empty={points.length === 0}
      view={view}
      onViewChange={setView}
      table={table}
      footer={withoutUsage > 0 ? `${withoutUsage} run${withoutUsage === 1 ? "" : "s"} without recorded usage not shown` : undefined}
    >
      <div ref={ref} className="h-full">
        <DotStrip
          points={points}
          months={monthsWithRuns}
          medianByMonth={medianByMonth}
          width={width}
          plotHeight={240}
          formatMonth={(m) => formatMonth(m, { current: data.currentMonth })}
        />
      </div>
    </ChartCard>
  );
}
