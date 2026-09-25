import type { Cost } from "../types.ts";
import { formatUsd, prettyModel } from "../cost.ts";
import { SectionHeader } from "./primitives.tsx";

export function CostPanel({ cost }: { cost: Cost }) {
  // `todayUsd` is null both when nothing happened today and when everything
  // that happened is unpriced -- treat null like 0 for the "nothing to show"
  // check so a quiet server doesn't grow this section out of nowhere.
  if (cost.liveTotalUsd === 0 && (cost.todayUsd === 0 || cost.todayUsd == null)) return null;

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
            API-equiv
          </span>
        }
      />
      {/* the one place a number is allowed to be bigger */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xs text-ink-4">today</div>
          <div
            data-testid="cost-today"
            className="font-mono text-base font-medium tabular-nums slashed-zero text-ink"
          >
            {formatUsd(cost.todayUsd)}
          </div>
        </div>
        <div>
          <div className="text-2xs text-ink-4">live total</div>
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
            <span className="min-w-0 flex-1 truncate text-ink-4">{prettyModel(m.model)}</span>
            <span className="tabular-nums slashed-zero text-ink-4">{formatUsd(m.costUsd)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
