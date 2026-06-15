import type { State, Session } from "../types.ts";
import { useNow } from "../useNow.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";

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
  const latestTool = new Map<string, string>();
  for (const a of state.activity) {
    if (!latestTool.has(a.session_id)) latestTool.set(a.session_id, a.tool);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <AppBar state={state} />

      <TodosSection todos={state.todos} />

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => {
          const items = bySession(c.id);
          return (
            <Column key={c.id} title={c.title} dot={c.dot} count={items.length}>
              {items.map((s) => (
                <SessionCard key={s.id} s={s} latestTool={latestTool.get(s.id)} />
              ))}
            </Column>
          );
        })}
      </Lane>

      <ActivityFeed activity={state.activity} sessions={state.sessions} />
    </div>
  );
}
