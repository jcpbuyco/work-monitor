import type { LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";

/** Live workflow strip. Renders NOTHING when no run is live — zero vertical
 *  footprint on non-workflow days, which matters given how hard the board is
 *  already fighting for space. Inner-scrolls like TodosSection. */
export function WorkflowsSection({ workflows }: { workflows: LiveWorkflow[] }) {
  // 1Hz re-render so each card's elapsed timer ticks.
  useNow();
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-workflows-collapsed");
  if (workflows.length === 0) return null;

  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          ⚙ Workflows ({workflows.length})
        </button>
        <a href="#/workflows" className="text-2xs text-muted-foreground transition hover:text-foreground">
          history →
        </a>
      </div>
      {!collapsed && (
        <div className="am-fade-in max-h-[40vh] overflow-y-auto pr-1">
          {workflows.map((w) => (
            <WorkflowRunCard key={w.run_id} w={w} />
          ))}
        </div>
      )}
    </section>
  );
}
