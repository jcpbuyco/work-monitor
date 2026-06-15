import type { State, Session, Activity } from "../types.ts";
import { useNow } from "../useNow.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { ToolStats } from "./ToolStats.tsx";
import { CostPanel } from "./CostPanel.tsx";

const SESSION_COLS: { id: Session["status"]; title: string; dot: string }[] = [
  { id: "working", title: "Working", dot: "bg-working" },
  { id: "needs_you", title: "Needs you", dot: "bg-attention" },
  { id: "idle", title: "Idle / done", dot: "bg-idle" },
];

export function Board({ state }: { state: State }) {
  // Re-render every second so relative timestamps tick live.
  useNow();

  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  // Newest-first activity → first entry per session is its latest tool call.
  const latest = new Map<string, Activity>();
  for (const a of state.activity) {
    if (!latest.has(a.session_id)) latest.set(a.session_id, a);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-12">
      <AppBar state={state} />

      <div className="mt-2 flex flex-col gap-6 lg:flex-row lg:items-start">
        <main className="min-w-0 flex-1">
          <TodosSection todos={state.todos} />

          <Lane label="Sessions" hint="auto — moves itself from agent hook events">
            {SESSION_COLS.map((c) => {
              const items = bySession(c.id);
              return (
                <Column key={c.id} title={c.title} dot={c.dot} count={items.length}>
                  {items.map((s) => (
                    <SessionCard
                      key={s.id}
                      s={s}
                      latestTool={latest.get(s.id)?.tool}
                      latestDetail={latest.get(s.id)?.detail ?? null}
                      cost={state.cost.perSession[s.id]}
                    />
                  ))}
                </Column>
              );
            })}
          </Lane>
        </main>

        <aside className="lg:sticky lg:top-20 lg:w-80 lg:shrink-0">
          <ToolStats stats={state.stats} />
          <CostPanel cost={state.cost} />
          <ActivityFeed activity={state.activity} sessions={state.sessions} />
        </aside>
      </div>
    </div>
  );
}
