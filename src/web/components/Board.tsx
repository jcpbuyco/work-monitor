import type { State, Session } from "../types.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";

const SESSION_COLS: { id: Session["status"]; title: string; dot: string }[] = [
  { id: "working", title: "Working", dot: "bg-working" },
  { id: "needs_you", title: "Needs you", dot: "bg-attention" },
  { id: "idle", title: "Idle / done", dot: "bg-idle" },
];

export function Board({ state }: { state: State }) {
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

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
                <SessionCard key={s.id} s={s} />
              ))}
            </Column>
          );
        })}
      </Lane>
    </div>
  );
}
