import type { LastRun, LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { ago } from "../time.ts";
import { formatUsd } from "../cost.ts";
import { SectionHeader } from "./primitives.tsx";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";

/** Live workflow strip. With no run live it either goes silent (nothing has
 *  ever run) or shows one line for the most recent settled run (§5.2) - so a
 *  failure that finished while you looked away still surfaces on the board
 *  instead of the section just disappearing. Inner-scrolls like TodosSection
 *  while a run is actually live. */
export function WorkflowsSection({ workflows, lastRun = null }: { workflows: LiveWorkflow[]; lastRun?: LastRun | null }) {
  // 1Hz re-render so each row's elapsed timer (and the last-run "ago") ticks.
  useNow();
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-workflows-collapsed");

  if (workflows.length === 0) {
    if (!lastRun) return null;
    return (
      <section className="mt-6">
        <div data-testid="wf-last-run" className="flex h-7 items-center gap-2 font-mono text-2xs text-ink-4">
          <span aria-hidden="true">⚙</span>
          <span className="min-w-0 truncate">
            Last run: {lastRun.name ?? lastRun.run_id} · {lastRun.status ?? "settled"}
            {lastRun.ended_at != null ? ` ${ago(lastRun.ended_at)}` : ""} · {formatUsd(lastRun.costUsd)}
          </span>
          <a href="#/workflows" className="ml-auto shrink-0 text-ink-4 transition-colors duration-quick ease-quad hover:text-ink">
            history →
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-6">
      <SectionHeader
        label={`⚙ Workflows (${workflows.length})`}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        right={
          <a
            href="#/workflows"
            className="text-2xs text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
          >
            history →
          </a>
        }
      />
      {!collapsed && (
        // see TodosSection: the scroller must absorb ROW_BASE's -mx-1.5 or it overflows
        <div className="am-fade-in max-h-[40vh] overflow-y-auto -mx-1.5 px-1.5">
          {workflows.map((w) => (
            <WorkflowRunCard key={w.run_id} w={w} />
          ))}
        </div>
      )}
    </section>
  );
}
