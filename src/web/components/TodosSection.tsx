import { useState } from "react";
import type { Todo } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { TodoCard } from "./TodoCard.tsx";
import { TodoModal } from "./TodoModal.tsx";
import { DoneDialog } from "./DoneDialog.tsx";

export function TodosSection({ todos }: { todos: Todo[] }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle("wm-todos-collapsed");
  const [doneOpen, setDoneOpen] = useState(false);
  const [selected, setSelected] = useState<Todo | null>(null);

  const open = todos.filter((t) => t.status === "todo");
  const done = todos.filter((t) => t.status === "done");

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
          ★ Todos ({open.length})
        </button>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
          ✓ to complete · ✕ to delete
        </span>
      </div>

      {!collapsed && (
        <div className="wm-fade-in grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            {open.length === 0 ? (
              <div className="rounded-xl border border-border bg-card/50 p-4 text-2xs text-muted-foreground">
                Nothing open. 🎉
              </div>
            ) : (
              open.map((t) => <TodoCard key={t.id} t={t} onOpen={setSelected} />)
            )}
            <button
              type="button"
              onClick={() => setDoneOpen(true)}
              className="mt-1 text-2xs font-semibold text-muted-foreground transition hover:text-foreground"
            >
              ✓ Done ({done.length}) →
            </button>
          </div>
        </div>
      )}

      <DoneDialog open={doneOpen} done={done} onClose={() => setDoneOpen(false)} />
      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
