import type { State, Session, Activity, LiveWorkflow } from "../types.ts";
import { useNow } from "../useNow.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ToolStats } from "./ToolStats.tsx";
import { CostPanel } from "./CostPanel.tsx";
import { CostBreakdown } from "./CostBreakdown.tsx";
import { WorkflowsSection } from "./WorkflowsSection.tsx";

/** Needs you first: the board's job is to tell you when it needs you. */
const SESSION_COLS: { id: Session["status"]; title: string }[] = [
  { id: "needs_you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "idle", title: "Idle / done" },
];

export function Board({ state, workflows = [] }: { state: State; workflows?: LiveWorkflow[] }) {
  // Re-render every second so relative timestamps tick live.
  useNow();

  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  // Newest-first activity → first entry per session is its latest tool call.
  const latest = new Map<string, Activity>();
  for (const a of state.activity) {
    if (!latest.has(a.session_id)) latest.set(a.session_id, a);
  }

  // Computed once per render rather than passing the array down to every card.
  const wfSessions = new Set(workflows.map((w) => w.session_id));

  return (
    <div className="mx-auto max-w-board px-6 pb-16">
      <AppBar state={state} workflows={workflows} />

      <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <main className="min-w-0 lg:pr-6">
          {/* First in main, no top margin. Together with the needs_you row tint
              these are the only two tinted surfaces in the whole app. */}
          {(state.workflows_degraded ?? 0) > 0 && (
            <div className="flex h-8 items-center gap-2 rounded-md border-hairline border-attention/25 bg-attention/[0.07] px-2.5 text-2xs text-attention">
              ⚠ workflow data looks off — Claude Code may have changed format
            </div>
          )}

          {/* Sessions are the reason the page exists; the 40vh caps on Todos and
              Workflows were compensating for them sitting third. */}
          <Lane label="Sessions" hint="auto — moves itself from agent hook events">
            {SESSION_COLS.map((c) => {
              const items = bySession(c.id);
              return (
                <Column key={c.id} title={c.title} dot={c.id} count={items.length}>
                  {items.map((s) => (
                    <SessionCard
                      key={s.id}
                      s={s}
                      latestTool={latest.get(s.id)?.tool}
                      latestDetail={latest.get(s.id)?.detail ?? null}
                      cost={state.cost.perSession[s.id]}
                      wf={wfSessions.has(s.id)}
                    />
                  ))}
                </Column>
              );
            })}
          </Lane>

          <WorkflowsSection workflows={workflows} />
          <TodosSection todos={state.todos} />
        </main>

        {/* One vertical hairline replaces four bordered card boxes. Below lg the
            grid stacks and the border drops — lg: prefixes only. */}
        <aside className="mt-6 lg:sticky lg:top-14 lg:mt-0 lg:border-l-hairline lg:border-border-weak lg:pl-6">
          <ToolStats stats={state.stats} />
          <CostPanel cost={state.cost} />
          <CostBreakdown cost={state.cost} />
          <ActivityFeed activity={state.activity} sessions={state.sessions} />
        </aside>
      </div>
    </div>
  );
}
