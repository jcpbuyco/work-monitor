import { useState } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatTokens } from "../../cost.ts";
import { compactUsd, formatMonth, orDash } from "../charts/format.ts";
import { KIND_VAR, KIND_ORDER, KIND_LABEL } from "../charts/palette.ts";
import { StackedColumns } from "../charts/StackedColumns.tsx";
import { Legend } from "../charts/Legend.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { xAxisBandPx } from "../charts/typography.ts";
import { useRootPx } from "../../useRootPx.ts";
import { Segmented } from "../primitives.tsx";

type Mode = "absolute" | "share";

/** C6: how much of monthly spend is main-session vs. delegated (subagents,
 *  workflows) -- an ordinal ramp (no delegation -> orchestrated), always
 *  stacked in that order. */
export function WhoDoesTheWork({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [mode, setMode] = useState<Mode>("absolute");
  const [view, setView] = useChartView();
  const [isolated, setIsolated] = useState<string | null>(null);
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const rootPx = useRootPx();

  const byMonth = new Map<string, Record<string, { costUsd: number | null; outputTokens: number }>>();
  for (const row of data.byMonthKind) {
    const m = byMonth.get(row.month) ?? {};
    m[row.kind] = { costUsd: row.costUsd, outputTokens: row.outputTokens };
    byMonth.set(row.month, m);
  }
  const runsByMonth = new Map<string, number>();
  for (const r of data.workflowRuns) if (r.month) runsByMonth.set(r.month, (runsByMonth.get(r.month) ?? 0) + 1);

  const values: Record<string, Record<string, number>> = {};
  const workflowShare = new Map<string, number>();
  for (const month of data.months) {
    const row = byMonth.get(month) ?? {};
    const abs = KIND_ORDER.reduce((acc, k) => ({ ...acc, [k]: row[k]?.costUsd ?? 0 }), {} as Record<string, number>);
    const total = KIND_ORDER.reduce((s, k) => s + abs[k], 0);
    workflowShare.set(month, total > 0 ? (abs.workflow / total) * 100 : 0);
    values[month] = mode === "absolute" ? abs : KIND_ORDER.reduce((acc, k) => ({ ...acc, [k]: total > 0 ? (abs[k] / total) * 100 : 0 }), {});
  }

  const formatValue = mode === "absolute" ? (v: number) => compactUsd(v) : (v: number) => `${v.toFixed(0)}%`;
  const legend = KIND_ORDER.map((k) => ({ id: k, label: KIND_LABEL[k], color: KIND_VAR[k] }));

  const table = (
    <DataTable
      caption="Who does the work"
      rowKey={(m) => m}
      rows={data.months}
      columns={[
        { key: "month", label: "Month", render: (m) => formatMonth(m, { current: data.currentMonth, withYear: true }) },
        // "-" for a month with no kind-of-work rows at all, not "$0.00"/"0%"/
        // "0" (reviewer finding, B18): `byMonth.has(m)` is true only when
        // there was real data that month.
        { key: "main", label: "Main", numeric: true, render: (m) => orDash(byMonth.has(m), formatUsd(byMonth.get(m)?.main?.costUsd ?? 0)) },
        { key: "subagent", label: "Subagent", numeric: true, render: (m) => orDash(byMonth.has(m), formatUsd(byMonth.get(m)?.subagent?.costUsd ?? 0)) },
        { key: "workflow", label: "Workflow", numeric: true, render: (m) => orDash(byMonth.has(m), formatUsd(byMonth.get(m)?.workflow?.costUsd ?? 0)) },
        { key: "share", label: "Workflow share", numeric: true, render: (m) => orDash(byMonth.has(m), `${(workflowShare.get(m) ?? 0).toFixed(0)}%`) },
        { key: "runs", label: "Runs", numeric: true, render: (m) => orDash(byMonth.has(m), String(runsByMonth.get(m) ?? 0)) },
      ]}
    />
  );

  return (
    <ChartCard
      title="Who does the work"
      subtitle="How much of monthly spend comes from orchestration rather than the main session?"
      legend={<Legend entries={legend} isolated={isolated} onToggle={setIsolated} />}
      // Always draws a "N runs" second line under the month tick (§R5): see
      // MonthlyByModel's own comment on this same pattern.
      height={220 + xAxisBandPx(rootPx, 2) + 12}
      loading={loading}
      refetching={refetching}
      view={view}
      onViewChange={setView}
      table={table}
      right={
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "absolute", label: "Absolute" },
            { value: "share", label: "Share" },
          ]}
        />
      }
    >
      <div ref={ref} className="h-full">
        <StackedColumns
          months={data.months}
          series={KIND_ORDER.map((k) => ({ id: k, label: KIND_LABEL[k], color: KIND_VAR[k] }))}
          values={values}
          width={width}
          plotHeight={220}
          formatValue={formatValue}
          formatAxis={mode === "share" ? (v) => `${v}%` : undefined}
          showTotal={mode === "absolute"}
          isolated={isolated || null}
          currentMonth={data.currentMonth}
          formatMonth={(m) => formatMonth(m, { current: data.currentMonth })}
          secondLine={(m) => `${runsByMonth.get(m) ?? 0} runs`}
          aboveLabel={(m) => {
            const s = workflowShare.get(m) ?? 0;
            return s > 0 ? `${s.toFixed(0)}%` : null;
          }}
          onClickSegment={(_m, seriesId) => {
            if (seriesId === "workflow") window.location.hash = "#/workflows";
          }}
          tooltipFor={(month) => {
            const row = byMonth.get(month) ?? {};
            const total = KIND_ORDER.reduce((s, k) => s + (row[k]?.costUsd ?? 0), 0) || 1;
            return (
              <div className="space-y-1">
                <div className="font-medium text-ink">{formatMonth(month, { current: data.currentMonth, withYear: true })}</div>
                {/* One value per row (§5/B9/B14, reviewer finding: this used
                   to pack cost, share and output tokens into one value
                   string -- "$1,234.56 · 42% · 3.1M out" -- the only tooltip
                   on the page doing that). The share is folded into the
                   label instead of a fourth row, matching how the chart's
                   own `aboveLabel` already reads this number. */}
                {KIND_ORDER.map((k) => (
                  <TooltipRow
                    key={k}
                    swatch={KIND_VAR[k]}
                    label={`${KIND_LABEL[k]} (${(((row[k]?.costUsd ?? 0) / total) * 100).toFixed(0)}%)`}
                    value={formatUsd(row[k]?.costUsd ?? 0)}
                  />
                ))}
                {KIND_ORDER.map((k) => (
                  <TooltipRow key={`${k}-out`} label={`${KIND_LABEL[k]} output`} value={formatTokens(row[k]?.outputTokens ?? 0)} indent />
                ))}
                <TooltipRow label="workflow runs" value={String(runsByMonth.get(month) ?? 0)} />
              </div>
            );
          }}
        />
      </div>
    </ChartCard>
  );
}
