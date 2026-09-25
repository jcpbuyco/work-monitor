import type { Cost } from "../types.ts";
import { formatUsd, formatTokens, prettyModel } from "../cost.ts";
import { SectionHeader } from "./primitives.tsx";

export function CostPanel({ cost }: { cost: Cost }) {
  // `todayUsd` is null both when nothing happened today and when everything
  // that happened is unpriced -- treat null like 0 for the "nothing to show"
  // check so a quiet server doesn't grow this section out of nowhere.
  if (cost.liveTotalUsd === 0 && (cost.todayUsd === 0 || cost.todayUsd == null)) return null;

  const unpricedModels = cost.unpricedModels ?? [];
  // §5.2 finding fix: `unpricedModels` is an ALL-TIME rollup while
  // `byModelToday` is scoped to today - a model unpriced today already shows
  // "unpriced" in the today list below, so listing it again in the all-time
  // list (unlabelled, inside a section otherwise scoped to "today (local)")
  // duplicated it. Drop any all-time entry already represented today, and
  // label what's left "all-time" so its different scope is explicit.
  const todayModels = new Set(cost.byModelToday.map((m) => m.model));
  const unpricedAllTimeOnly = unpricedModels.filter((m) => !todayModels.has(m.model));

  return (
    <section className="mt-6">
      <SectionHeader
        label="Session cost"
        leading={<span aria-hidden="true" className="text-ink-4">$</span>}
        right={
          <span
            className="text-3xs text-ink-4"
            title="Notional API-equivalent cost — subscription plans aren't billed per token."
          >
            ≈ API list price
          </span>
        }
      />
      {/* the one place a number is allowed to be bigger */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xs text-ink-4">today (local)</div>
          <div
            data-testid="cost-today"
            className="font-mono text-base font-medium tabular-nums slashed-zero text-ink"
          >
            {formatUsd(cost.todayUsd)}
          </div>
        </div>
        <div>
          <div className="text-2xs text-ink-4">open sessions</div>
          <div
            data-testid="cost-live-total"
            className="font-mono text-base tabular-nums slashed-zero text-ink-3"
          >
            {formatUsd(cost.liveTotalUsd)}
          </div>
        </div>
      </div>
      <ul className="mt-2">
        {cost.byModelToday.map((m) => (
          <li key={m.model} className="flex h-5 items-center gap-2 font-mono text-2xs">
            <span className="min-w-0 flex-1 truncate text-ink-4" title={m.model}>{prettyModel(m.model)}</span>
            <span className="tabular-nums slashed-zero text-ink-4">{formatUsd(m.costUsd)}</span>
          </li>
        ))}
        {/* §5.2: all-time unpriced usage, spelled out with a token count rather
            than folded into "today"'s $0.00-that-isn't-really-zero list - a
            model can be unpriced for months before anyone notices it in the
            per-day breakdown alone. Only models with NO row in today's list
            above (deduped, and explicitly "all-time" so its different scope
            from the rest of this section is never ambiguous). */}
        {unpricedAllTimeOnly.map((m) => (
          <li key={`unpriced-${m.model}`} className="flex h-5 items-center gap-2 font-mono text-2xs" title={m.model}>
            <span className="min-w-0 flex-1 truncate text-ink-4">
              {prettyModel(m.model)} · unpriced · all-time · {formatTokens(m.tokens)} tok
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
