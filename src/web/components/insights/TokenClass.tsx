import { useState } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatTokens } from "../../cost.ts";
import { compactUsd, formatMonth, orDash } from "../charts/format.ts";
import { TOKEN_CLASS_VAR, TOKEN_CLASS_ORDER, TOKEN_CLASS_LABEL } from "../charts/palette.ts";
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

/** C5: cost by token class (cache read / cache write / output / uncached
 *  input) -- roughly 83% of lifetime spend is context, not output. */
export function TokenClass({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [mode, setMode] = useState<Mode>("absolute");
  const [view, setView] = useChartView();
  const [isolated, setIsolated] = useState<string | null>(null);
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const rootPx = useRootPx();

  const byMonth = new Map(data.byMonthTokenClass.map((r) => [r.month, r]));
  const values: Record<string, Record<string, number>> = {};
  for (const month of data.months) {
    const row = byMonth.get(month);
    const abs = {
      cacheRead: row?.cacheReadUsd ?? 0,
      cacheWrite: row?.cacheWriteUsd ?? 0,
      output: row?.outputUsd ?? 0,
      input: row?.inputUsd ?? 0,
    };
    if (mode === "absolute") {
      values[month] = abs;
    } else {
      const total = abs.cacheRead + abs.cacheWrite + abs.output + abs.input || 1;
      values[month] = {
        cacheRead: (abs.cacheRead / total) * 100,
        cacheWrite: (abs.cacheWrite / total) * 100,
        output: (abs.output / total) * 100,
        input: (abs.input / total) * 100,
      };
    }
  }

  const formatValue = mode === "absolute" ? (v: number) => compactUsd(v) : (v: number) => `${v.toFixed(0)}%`;
  // "Uncached input" IS drawn (it's a real, if usually sub-pixel, segment), so
  // it belongs in the legend too -- omitting it left the one drawn segment
  // with no key at all (reviewer finding).
  const legend = TOKEN_CLASS_ORDER.map((c) => ({ id: c, label: TOKEN_CLASS_LABEL[c], color: TOKEN_CLASS_VAR[c] }));

  const lifetimeTotals = TOKEN_CLASS_ORDER.reduce(
    (acc, c) => {
      acc[c] = data.byMonthTokenClass.reduce((s, r) => s + (c === "cacheRead" ? r.cacheReadUsd : c === "cacheWrite" ? r.cacheWriteUsd : c === "output" ? r.outputUsd : r.inputUsd), 0);
      return acc;
    },
    {} as Record<string, number>
  );
  const lifetimeTotal = Object.values(lifetimeTotals).reduce((a, b) => a + b, 0) || 1;
  const contextShare = ((lifetimeTotals.cacheRead + lifetimeTotals.cacheWrite) / lifetimeTotal) * 100;

  const table = (
    <DataTable
      caption="Cost by token class"
      rowKey={(m) => m}
      rows={data.months}
      columns={[
        { key: "month", label: "Month", render: (m) => formatMonth(m, { current: data.currentMonth, withYear: true }) },
        // "-" for a month with no token-class rows at all, not "$0.00"
        // (reviewer finding, B18): `!!byMonth.get(m)` is true only when
        // there was real data that month.
        { key: "cacheRead", label: "Cache read", numeric: true, render: (m) => orDash(!!byMonth.get(m), formatUsd(byMonth.get(m)?.cacheReadUsd ?? 0)) },
        { key: "cacheWrite", label: "Cache write", numeric: true, render: (m) => orDash(!!byMonth.get(m), formatUsd(byMonth.get(m)?.cacheWriteUsd ?? 0)) },
        { key: "output", label: "Output", numeric: true, render: (m) => orDash(!!byMonth.get(m), formatUsd(byMonth.get(m)?.outputUsd ?? 0)) },
        { key: "input", label: "Input", numeric: true, render: (m) => orDash(!!byMonth.get(m), formatUsd(byMonth.get(m)?.inputUsd ?? 0)) },
        {
          key: "total",
          label: "Total",
          numeric: true,
          render: (m) => {
            const r = byMonth.get(m);
            return orDash(!!r, formatUsd(r ? r.cacheReadUsd + r.cacheWriteUsd + r.outputUsd + r.inputUsd : 0));
          },
        },
        {
          key: "1hshare",
          label: "1h cache write share",
          numeric: true,
          render: (m) => {
            const r = byMonth.get(m);
            if (!r) return "-";
            const total = r.cacheWrite1hTokens + r.cacheWrite5mTokens;
            return total === 0 ? "-" : `${((r.cacheWrite1hTokens / total) * 100).toFixed(0)}%`;
          },
        },
      ]}
    />
  );

  return (
    <ChartCard
      title="Cost by token class"
      subtitle={`About ${contextShare.toFixed(0)}% of spend is context, not output`}
      legend={<Legend entries={legend} isolated={isolated} onToggle={setIsolated} />}
      height={220 + xAxisBandPx(rootPx, 1) + 12}
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
          series={TOKEN_CLASS_ORDER.map((c) => ({ id: c, label: TOKEN_CLASS_LABEL[c], color: TOKEN_CLASS_VAR[c] }))}
          values={values}
          width={width}
          plotHeight={220}
          formatValue={formatValue}
          formatAxis={mode === "share" ? (v) => `${v}%` : undefined}
          showTotal={mode === "absolute"}
          isolated={isolated || null}
          currentMonth={data.currentMonth}
          formatMonth={(m) => formatMonth(m, { current: data.currentMonth })}
          tooltipFor={(month) => {
            const row = byMonth.get(month);
            return (
              <div className="space-y-1">
                <div className="font-medium text-ink">{formatMonth(month, { current: data.currentMonth, withYear: true })}</div>
                {TOKEN_CLASS_ORDER.map((c) => (
                  <TooltipRow key={c} swatch={TOKEN_CLASS_VAR[c]} label={TOKEN_CLASS_LABEL[c]} value={mode === "absolute" ? formatUsd(values[month][c]) : `${values[month][c].toFixed(0)}%`} />
                ))}
                {row && row.cacheWrite5mTokens + row.cacheWrite1hTokens > 0 && (
                  <TooltipRow
                    label="1h cache write share"
                    value={`${((row.cacheWrite1hTokens / (row.cacheWrite1hTokens + row.cacheWrite5mTokens)) * 100).toFixed(0)}%`}
                  />
                )}
                {row && row.unpricedTokens > 0 && <TooltipRow label="unpriced tokens" value={formatTokens(row.unpricedTokens)} />}
              </div>
            );
          }}
        />
      </div>
    </ChartCard>
  );
}
