import { useState } from "react";
import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatTokens, prettyModel } from "../../cost.ts";
import { compactUsd, compactTokens, formatDeltaPct, formatMonth, orDash } from "../charts/format.ts";
import { FAMILY_VAR, FAMILY_ORDER } from "../charts/palette.ts";
import { StackedColumns } from "../charts/StackedColumns.tsx";
import { Legend } from "../charts/Legend.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";
import { xAxisBandPx } from "../charts/typography.ts";
import { useRootPx } from "../../useRootPx.ts";
import { Segmented } from "../primitives.tsx";

type Metric = "cost" | "tokens" | "output";

/** C3: monthly spend by model family, stacked, with a Cost/Tokens/Output
 *  toggle. Families are always Fable/Opus/Sonnet/Other, in that fixed
 *  stacking order (never re-sorted, per §5). */
export function MonthlyByModel({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [metric, setMetric] = useState<Metric>("cost");
  const [view, setView] = useChartView();
  const [isolated, setIsolated] = useState<string | null>(null);
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const rootPx = useRootPx();

  const byMonth = new Map<string, Map<string, { costUsd: number | null; tokens: number; outputTokens: number; unpriced: number }>>();
  for (const row of data.byMonthModel) {
    let m = byMonth.get(row.month);
    if (!m) {
      m = new Map();
      byMonth.set(row.month, m);
    }
    m.set(row.model, { costUsd: row.costUsd, tokens: row.tokens, outputTokens: row.outputTokens, unpriced: row.unpricedTokens });
  }

  const values: Record<string, Record<string, number>> = {};
  const monthUnpriced = new Map<string, number>();
  const monthTotalRaw = new Map<string, number | null>();
  for (const month of data.months) {
    const models = byMonth.get(month);
    const perFamily: Record<string, number> = { Fable: 0, Opus: 0, Sonnet: 0, Other: 0 };
    let unpriced = 0;
    let total = 0;
    let anyPriced = false;
    if (models) {
      for (const row of data.byMonthModel.filter((r) => r.month === month)) {
        const v = metric === "cost" ? row.costUsd ?? 0 : metric === "tokens" ? row.tokens : row.outputTokens;
        perFamily[row.family] += v;
        unpriced += row.unpricedTokens;
        if (metric !== "cost") {
          total += v;
        } else if (row.costUsd != null) {
          total += row.costUsd;
          anyPriced = true;
        }
      }
    }
    values[month] = perFamily;
    monthUnpriced.set(month, unpriced);
    monthTotalRaw.set(month, metric === "cost" ? (anyPriced || !models ? total : null) : total);
  }

  const monthTotals = data.months.map((m) => monthTotalRaw.get(m) ?? 0);
  const formatValue = metric === "cost" ? (v: number) => compactUsd(v) : (v: number) => compactTokens(v);
  // The exact-value twin of `formatValue`, for table cells (which show real
  // token counts, not the chart's compact "10.8k" form) -- e.g. `formatUsd`'s
  // cents for Cost, `formatTokens` for Tokens/Output. Table cells previously
  // always used `formatUsd` regardless of the active metric, so switching to
  // Tokens printed a token count as a dollar figure (reviewer finding: "Feb
  // 2026 ... $33704423.00").
  const renderValue = metric === "cost" ? (v: number) => formatUsd(v) : (v: number) => formatTokens(v);

  const legend = FAMILY_ORDER.map((f) => ({ id: f, label: f, color: FAMILY_VAR[f] }));

  const projection =
    metric === "cost" && data.kpi.projectedMonthEndUsd != null
      ? { month: data.currentMonth, to: data.kpi.projectedMonthEndUsd, label: `proj. ~${compactUsd(data.kpi.projectedMonthEndUsd)}` }
      : null;

  const table = (
    <DataTable
      caption="Monthly spend by model family"
      rowKey={(m) => m}
      rows={data.months}
      columns={[
        { key: "month", label: "Month", render: (m) => formatMonth(m, { current: data.currentMonth, withYear: true }) },
        // A wholly empty month (Mar/Apr in the spec's own worked example --
        // no usage rows at all, not even a priced $0 one) reads "-" in EVERY
        // numeric cell, not just Total (reviewer finding, B18: "Total '-' but
        // family cells '$0.00' in the same row") -- `!!byMonth.get(m)` is
        // true only when there was real data that month, as distinct from a
        // month whose rows happen to sum to exactly zero.
        { key: "fable", label: "Fable", numeric: true, render: (m) => orDash(!!byMonth.get(m), renderValue(values[m].Fable)) },
        { key: "opus", label: "Opus", numeric: true, render: (m) => orDash(!!byMonth.get(m), renderValue(values[m].Opus)) },
        { key: "sonnet", label: "Sonnet", numeric: true, render: (m) => orDash(!!byMonth.get(m), renderValue(values[m].Sonnet)) },
        { key: "other", label: "Other", numeric: true, render: (m) => orDash(!!byMonth.get(m), renderValue(values[m].Other)) },
        {
          key: "total",
          label: "Total",
          numeric: true,
          render: (m) => orDash(!!byMonth.get(m), renderValue(monthTotalRaw.get(m) ?? 0)),
        },
        {
          key: "mom",
          label: "MoM",
          numeric: true,
          // Same helper (and so the same "↑97%"/"↓12%" spelling) as the
          // chart's own MoM second line just below -- a plain sign here would
          // be a second, inconsistent delta convention next to the chart it's
          // the exact-number twin of (reviewer finding, B17).
          render: (m) => {
            const i = data.months.indexOf(m);
            return i > 0 ? formatDeltaPct(monthTotals[i], monthTotals[i - 1]) ?? "-" : "-";
          },
        },
      ]}
    />
  );

  return (
    <ChartCard
      title="Monthly spend by model"
      subtitle="How fast is monthly spend growing, and which models make up each month?"
      legend={<Legend entries={legend} isolated={isolated} onToggle={setIsolated} />}
      // This card always draws a MoM second line under the month tick (§R5):
      // the floor has to grow with `xAxisBandPx`'s own scaled 2-line budget,
      // not a flat `+32`, or the chart's own (correctly-scaled) axis band
      // outgrows the card's floor at a larger text size and paints into the
      // card's bottom padding below it.
      height={220 + xAxisBandPx(rootPx, 2) + 12}
      loading={loading}
      refetching={refetching}
      view={view}
      onViewChange={setView}
      table={table}
      // Unlike every other card's metric toggle, this one changes which
      // COLUMNS the table itself renders (Cost/Tokens/Output each pick a
      // different `renderValue`) -- hiding it in Table view (ChartCard's
      // default, since a toggle usually only affects the chart) would strand
      // whoever's in Table view on whatever metric they last had selected in
      // Chart view, with no way to switch without leaving Table (reviewer
      // finding; ChartCard's own doc comment names this exact card).
      keepRightInTable
      right={
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: "cost", label: "Cost" },
            { value: "tokens", label: "Tokens" },
            { value: "output", label: "Output" },
          ]}
        />
      }
    >
      <div ref={ref} className="h-full">
        <StackedColumns
          months={data.months}
          series={FAMILY_ORDER.map((f) => ({ id: f, label: f, color: FAMILY_VAR[f] }))}
          values={values}
          width={width}
          plotHeight={220}
          formatValue={formatValue}
          formatAxis={formatValue}
          isolated={isolated || null}
          currentMonth={data.currentMonth}
          formatMonth={(m) => formatMonth(m, { current: data.currentMonth })}
          projection={projection}
          secondLine={(m) => {
            const i = data.months.indexOf(m);
            if (i === 0) return null;
            return formatDeltaPct(monthTotals[i], monthTotals[i - 1]);
          }}
          tooltipFor={(month) => {
            const models = data.byMonthModel.filter((r) => r.month === month).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
            const unpriced = monthUnpriced.get(month) ?? 0;
            return (
              <div className="space-y-1">
                <div className="font-medium text-ink">
                  {formatMonth(month, { current: data.currentMonth, withYear: true })} · {formatValue(monthTotalRaw.get(month) ?? 0)}
                </div>
                {FAMILY_ORDER.map((f) => (
                  <div key={f}>
                    <TooltipRow swatch={FAMILY_VAR[f]} label={f} value={formatValue(values[month][f])} />
                    {models
                      .filter((r) => r.family === f && values[month][f] > 0)
                      .slice(0, 4)
                      .map((r) => (
                        <TooltipRow key={r.model} label={prettyModel(r.model)} value={formatValue(metric === "cost" ? r.costUsd ?? 0 : metric === "tokens" ? r.tokens : r.outputTokens)} indent />
                      ))}
                  </div>
                ))}
                {unpriced > 0 && <TooltipRow label="unpriced tokens" value={formatTokens(unpriced)} />}
              </div>
            );
          }}
        />
      </div>
    </ChartCard>
  );
}
