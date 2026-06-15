import { useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { State, Session, TodoStatus, Todo } from "../types.ts";
import { patchTodo } from "../api.ts";
import { resolveDrop } from "../drag.ts";
import { Lane, Column } from "./Lane.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodoModal } from "./TodoModal.tsx";

const TODO_COLS: { id: TodoStatus; title: string; dot: string }[] = [
  { id: "todo", title: "To do", dot: "bg-attention" },
  { id: "done", title: "Done", dot: "bg-done" },
];

const SESSION_COLS: { id: Session["status"]; title: string; dot: string }[] = [
  { id: "working", title: "Working", dot: "bg-working" },
  { id: "needs_you", title: "Needs you", dot: "bg-attention" },
  { id: "idle", title: "Idle / done", dot: "bg-idle" },
];

export function Board({ state }: { state: State }) {
  const [selected, setSelected] = useState<Todo | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const byTodo = (s: TodoStatus) => state.todos.filter((t) => t.status === s);
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  function onDragEnd(e: DragEndEvent) {
    const drop = resolveDrop(state.todos, String(e.active.id), e.over ? String(e.over.id) : null);
    if (drop) patchTodo(drop.id, { status: drop.status });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <AppBar state={state} />

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <Lane label="★ Todos" hint="manual — drag cards as you deal with them">
          {TODO_COLS.map((c) => {
            const items = byTodo(c.id);
            return (
              <Column key={c.id} id={c.id} title={c.title} dot={c.dot} count={items.length} droppable>
                {items.map((t) => (
                  <TodoCard key={t.id} t={t} onOpen={setSelected} />
                ))}
              </Column>
            );
          })}
        </Lane>
      </DndContext>

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => {
          const items = bySession(c.id);
          return (
            <Column key={c.id} id={`sess-${c.id}`} title={c.title} dot={c.dot} count={items.length}>
              {items.map((s) => (
                <SessionCard key={s.id} s={s} />
              ))}
            </Column>
          );
        })}
      </Lane>

      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
