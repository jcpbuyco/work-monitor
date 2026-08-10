import type { LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { SectionHeader } from "./primitives.tsx";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";

/** Live workflow strip. Renders NOTHING when no run is live — zero vertical
 *  footprint on non-workflow days, which matters given how hard the board is
 *  already fighting for space. Inner-scrolls like TodosSection. */
export function WorkflowsSection({ workflows }: { workflows: LiveWorkflow[] }) {
  // 1Hz re-render so each row's elapsed timer ticks.
  useNow();
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-workflows-collapsed");
  if (workflows.length === 0) return null;

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
        <div className="am-fade-in max-h-[40vh] overflow-y-auto pr-1">
          {workflows.map((w) => (
            <WorkflowRunCard key={w.run_id} w={w} />
          ))}
        </div>
      )}
    </section>
  );
}
