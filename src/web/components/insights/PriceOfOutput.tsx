import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatTokens, prettyModel } from "../../cost.ts";
import { HBars } from "../charts/HBars.tsx";
import { TooltipRow } from "../charts/Tooltip.tsx";
import { DataTable } from "../charts/DataTable.tsx";
import { ChartCard, useChartView } from "../charts/ChartCard.tsx";
import { useChartWidth } from "../charts/useChartWidth.ts";

/** C8: all-in cost per 1M output tokens (context included) against list
 *  output price, for every model with meaningful lifetime output. */
export function PriceOfOutput({ data, loading, refetching }: { data: InsightsResponse; loading?: boolean; refetching?: boolean }) {
  const [view, setView] = useChartView();
  const [ref, width] = useChartWidth<HTMLDivElement>();

  const rows = [...data.models]
    .map((m) => {
      const allIn = m.outputTokens > 0 ? (m.costUsd ?? 0) / (m.outputTokens / 1e6) : 0;
      const multiple = m.listOutputRate ? allIn / m.listOutputRate : null;
      return { ...m, allIn, multiple };
    })
    .sort((a, b) => b.allIn - a.allIn);

  const table = (
    <DataTable
      caption="Price of output by model"
      rowKey={(r) => r.model}
      rows={rows}
      columns={[
        { key: "model", label: "Model", render: (r) => prettyModel(r.model) },
        { key: "allIn", label: "All-in $/M", numeric: true, render: (r) => `$${r.allIn.toFixed(0)}` },
        { key: "list", label: "List $/M", numeric: true, render: (r) => (r.listOutputRate != null ? `$${r.listOutputRate}` : "-") },
        { key: "mult", label: "Multiple", numeric: true, render: (r) => (r.multiple != null ? `${r.multiple.toFixed(1)}x` : "-") },
        { key: "lifetime", label: "Lifetime $", numeric: true, render: (r) => formatUsd(r.costUsd) },
        { key: "output", label: "Output tokens", numeric: true, render: (r) => formatTokens(r.outputTokens) },
        { key: "30d", label: "30d all-in $/M", numeric: true, render: (r) => (r.outputTokens30d > 0 ? `$${((r.costUsd30d ?? 0) / (r.outputTokens30d / 1e6)).toFixed(0)}` : "-") },
      ]}
    />
  );

  return (
    <ChartCard
      title="Price of output by model"
      subtitle="All-in cost per 1M output tokens, context included, against list price"
      legend={
        <div className="flex items-center gap-4 text-2xs text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--viz-s1)" }} />
            all-in $ per 1M output
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-0 w-2.5 border-t-2" style={{ borderColor: "var(--viz-context)" }} />
            list output price
          </span>
        </div>
      }
      height={rows.length * 28 + 24}
      loading={loading}
      refetching={refetching}
      empty={rows.length === 0}
      view={view}
      onViewChange={setView}
      table={table}
    >
      <div ref={ref} className="h-full">
        <HBars
          width={width}
          formatAxis={(v) => `$${v}`}
          rows={rows.map((r) => ({
            id: r.model,
            label: prettyModel(r.model),
            value: r.allIn,
            reference: r.listOutputRate ?? undefined,
            directLabel: `$${r.allIn.toFixed(0)}${r.multiple != null ? ` · ${r.multiple.toFixed(1)}x list` : ""}`,
            tooltip: (
              <div className="space-y-1">
                <div className="font-medium text-ink">{prettyModel(r.model)}</div>
                <TooltipRow label="lifetime $" value={formatUsd(r.costUsd)} />
                <TooltipRow label="output tokens" value={formatTokens(r.outputTokens)} />
                <TooltipRow label="multiple of list" value={r.multiple != null ? `${r.multiple.toFixed(1)}x` : "-"} />
                <TooltipRow label="cache share of $" value={r.costUsd ? `${((r.cacheUsd / r.costUsd) * 100).toFixed(0)}%` : "-"} />
                <TooltipRow label="last 30 days all-in $/M" value={r.outputTokens30d > 0 ? `$${((r.costUsd30d ?? 0) / (r.outputTokens30d / 1e6)).toFixed(0)}` : "-"} />
              </div>
            ),
          }))}
        />
      </div>
    </ChartCard>
  );
}
