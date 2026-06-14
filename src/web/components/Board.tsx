import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import type { State, Session, TodoStatus } from "../types.ts";
import { patchTodo } from "../api.ts";
import { resolveDrop } from "../drag.ts";
import { Lane, Column } from "./Lane.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { SessionCard } from "./SessionCard.tsx";

const TODO_COLS: { id: TodoStatus; title: string; accent: string }[] = [
  { id: "to_hand_off", title: "◇ To hand off", accent: "text-amber-400" },
  { id: "handed_off", title: "◇ Handed off", accent: "text-indigo-400" },
  { id: "done", title: "✓ Done", accent: "text-emerald-400" },
];

const SESSION_COLS: { id: Session["status"]; title: string; accent: string }[] = [
  { id: "working", title: "● Working", accent: "text-blue-400" },
  { id: "needs_you", title: "● Needs you", accent: "text-amber-400" },
  { id: "idle", title: "● Idle / done", accent: "text-slate-400" },
];

export function Board({ state }: { state: State }) {
  const byTodo = (s: TodoStatus) => state.todos.filter((t) => t.status === s);
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  function onDragEnd(e: DragEndEvent) {
    const drop = resolveDrop(state.todos, String(e.active.id), e.over ? String(e.over.id) : null);
    if (drop) patchTodo(drop.id, { status: drop.status });
  }

  return (
    <div className="max-w-6xl mx-auto p-4">
      <h1 className="text-lg font-semibold text-slate-100 mb-4">work-monitor</h1>

      <DndContext onDragEnd={onDragEnd}>
        <Lane label="★ Hand-offs & todos" hint="manual — drag cards as you deal with them">
          {TODO_COLS.map((c) => (
            <Column key={c.id} id={c.id} title={c.title} accent={c.accent} count={byTodo(c.id).length} droppable>
              {byTodo(c.id).map((t) => (
                <TodoCard key={t.id} t={t} />
              ))}
            </Column>
          ))}
        </Lane>
      </DndContext>

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => (
          <Column key={c.id} id={`sess-${c.id}`} title={c.title} accent={c.accent} count={bySession(c.id).length}>
            {bySession(c.id).map((s) => (
              <SessionCard key={s.id} s={s} />
            ))}
          </Column>
        ))}
      </Lane>
    </div>
  );
}
