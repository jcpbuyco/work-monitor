import type { InsightsResponse } from "../../../shared/insights.ts";
import { formatUsd, formatUsdWhole, formatTokens } from "../../cost.ts";
import { compactUsd } from "../charts/format.ts";
import { sparklineFrom } from "../../insights.ts";
import { HeroFigure, StatTile, Sparkline, Meter } from "../charts/StatTile.tsx";

function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1]} ${y}`;
}

/** C1: the hero lifetime figure plus four KPI tiles (this month, projected
 *  month end, lifetime tokens, cache hit rate). Not a chart -- the numbers ARE
 *  the content (§6). */
export function KpiRow({ data }: { data: InsightsResponse }) {
  const { kpi, meta } = data;
  const monthly = new Map<string, { costUsd: number; tokens: number }>();
  for (const row of data.byMonthModel) {
    const m = monthly.get(row.month) ?? { costUsd: 0, tokens: 0 };
    m.costUsd += row.costUsd ?? 0;
    m.tokens += row.tokens;
    monthly.set(row.month, m);
  }
  const monthlySeries = data.months.map((m) => ({ month: m, value: monthly.get(m)?.costUsd ?? 0 }));
  const tokenSeries = data.months.map((m) => ({ month: m, value: monthly.get(m)?.tokens ?? 0 }));
  const spendSpark = sparklineFrom(monthlySeries);
  const tokenSpark = sparklineFrom(tokenSeries);

  const firstDate = meta.firstAt != null ? new Date(meta.firstAt) : null;
  const sinceLabel = firstDate
    ? firstDate.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })
    : "-";

  // Whole-dollar with a thousands separator for anything at least $1 (matches
  // the hero figure's own convention), but keeps `formatUsd`'s cents for a
  // genuinely sub-dollar harness (Cursor's $0.08) -- `formatUsdWhole` alone
  // would round that away to "$0". The plain `formatUsd` this replaced had no
  // separator at all, e.g. "Claude $10899.09" (reviewer finding).
  const formatHarnessUsd = (n: number | null): string => (n != null && n > 0 && n < 1 ? formatUsd(n) : formatUsdWhole(n));
  const harnessLine = kpi.byHarness
    .map((h) => `${h.harness[0].toUpperCase()}${h.harness.slice(1)} ${formatHarnessUsd(h.costUsd)}`)
    .join(" · ");

  const mtdDeltaVsAugPoint = pct(kpi.mtdUsd, kpi.prevMonthSamePointUsd);
  const mtdDeltaVsAugAll = pct(kpi.mtdUsd, kpi.prevMonthUsd);
  const currentMonthIdx = data.months.indexOf(data.currentMonth);
  const prevMonthShortName = currentMonthIdx > 0 ? monthLabel(data.months[currentMonthIdx - 1]).split(" ")[0] : "last month";
  // Hero/tile figures are big, standalone, whole-dollar numbers (§5), unlike
  // formatUsd's exact-cents convention used in tables and axis ticks -- see
  // formatUsdWhole's doc. The "$x+" partial-unpriced suffix still applies.
  const heroUnpriced = meta.unpricedTokens > 0;
  const heroText = `${formatUsdWhole(kpi.lifetimeUsd)}${heroUnpriced ? "+" : ""}`;
  const heroTitle = heroUnpriced ? "some usage from unpriced models" : undefined;

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-3 lg:gap-4 lg:space-y-0">
      <div className="rounded-lg border-hairline border-border bg-surface-1 p-4 lg:col-span-1" title={heroTitle}>
        <HeroFigure
          value={heroText}
          subline={`since ${sinceLabel} · ${kpi.activeDays} active days · ${kpi.messages.toLocaleString()} messages${
            heroTitle ? ` · ${heroTitle}` : ""
          }`}
          footnote={`${kpi.sessions} sessions · ${kpi.workflowRuns} workflow runs · ${kpi.workflowAgents} workflow agents · ${kpi.projects} projects${
            harnessLine ? ` · ${harnessLine}` : ""
          }`}
        />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:col-span-2">
        <StatTile
          label="This month"
          value={formatUsdWhole(kpi.mtdUsd)}
          deltas={[
            ...(mtdDeltaVsAugPoint ? [{ text: `vs ${prevMonthShortName} at this point ${mtdDeltaVsAugPoint}` }] : []),
            ...(mtdDeltaVsAugAll ? [{ text: `vs all of ${prevMonthShortName} ${mtdDeltaVsAugAll}` }] : []),
          ]}
        >
          {spendSpark.length > 1 && (
            <Sparkline points={spendSpark.map((s) => s.value)} labels={spendSpark.map((s) => `${monthLabel(s.month)} · ${formatUsd(s.value)}`)} />
          )}
        </StatTile>
        <StatTile
          label="Projected month end"
          value={kpi.projectedMonthEndUsd == null ? "-" : compactUsd(kpi.projectedMonthEndUsd)}
          info="MTD + (trailing 7-day spend / 7) x days remaining in the month"
          deltas={
            kpi.projectedMonthEndUsd == null
              ? [{ text: "too early to project" }]
              : kpi.trailing7dUsd != null
                ? [{ text: `at the trailing 7-day rate (${compactUsd((kpi.trailing7dUsd ?? 0) / 7)}/day)` }]
                : undefined
          }
        />
        <StatTile label="Lifetime tokens" value={formatTokens(kpi.lifetimeTokens)} deltas={[{ text: `${formatTokens(kpi.outputTokens)} output · ${formatTokens(kpi.inputTokens)} uncached input` }]}>
          {tokenSpark.length > 1 && (
            <Sparkline points={tokenSpark.map((s) => s.value)} labels={tokenSpark.map((s) => `${monthLabel(s.month)} · ${formatTokens(s.value)}`)} />
          )}
        </StatTile>
        <StatTile
          label="Cache hit rate"
          value={`${(kpi.cacheHitRate * 100).toFixed(1)}%`}
          deltas={[{ text: `about ${compactUsd(kpi.cacheSavingsUsdEst)} saved vs uncached input (est.)` }]}
        >
          <Meter frac={kpi.cacheHitRate} label={`Cache hit rate ${(kpi.cacheHitRate * 100).toFixed(1)}%`} />
        </StatTile>
      </div>
    </div>
  );
}

function pct(current: number | null, previous: number | null): string | null {
  if (current == null || previous == null || previous === 0) return null;
  const p = ((current - previous) / previous) * 100;
  const arrow = p >= 0 ? "↑" : "↓";
  return `${arrow}${Math.abs(p).toFixed(0)}%`;
}
