import type { Cost } from "../types.ts";
import { formatUsd, prettyModel } from "../cost.ts";

export function CostPanel({ cost }: { cost: Cost }) {
  if (cost.liveTotalUsd === 0 && cost.todayUsd === 0) return null;

  return (
    <section className="mt-7">
      <div className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span aria-hidden="true">$</span> Session cost
        <span
          className="ml-auto rounded-full bg-chip px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60"
          title="Notional API-equivalent cost — subscription plans aren't billed per token."
        >
          API-equiv
        </span>
      </div>
      <ul className="space-y-1 font-mono text-2xs">
        <li className="flex items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1 text-foreground">live total</span>
          <span className="tabular-nums text-muted-foreground">{formatUsd(cost.liveTotalUsd)}</span>
        </li>
        <li className="flex items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1 text-foreground">today</span>
          <span className="tabular-nums text-muted-foreground">{formatUsd(cost.todayUsd)}</span>
        </li>
        {cost.byModelToday.map((m) => (
          <li key={m.model} className="flex items-center gap-2 px-2 py-1 text-muted-foreground/70">
            <span className="min-w-0 flex-1 truncate">{prettyModel(m.model)}</span>
            <span className="tabular-nums">{formatUsd(m.costUsd)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
