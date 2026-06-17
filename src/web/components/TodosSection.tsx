import { useState } from "react";
import type { Todo } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { TodoCard } from "./TodoCard.tsx";
import { TodoModal } from "./TodoModal.tsx";
import { DoneDialog } from "./DoneDialog.tsx";

export function TodosSection({ todos }: { todos: Todo[] }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle("am-todos-collapsed");
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
        <div className="am-fade-in">
          {open.length === 0 ? (
            <div className="rounded-xl border border-border bg-card/50 p-4 text-2xs text-muted-foreground">
              Nothing open. 🎉
            </div>
          ) : (
            <div className="max-h-[40vh] overflow-y-auto pr-1">
              <div className="columns-1 gap-2 sm:columns-2 xl:columns-3">
                {open.map((t) => (
                  <TodoCard key={t.id} t={t} onOpen={setSelected} />
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setDoneOpen(true)}
            className="mt-1 text-2xs font-semibold text-muted-foreground transition hover:text-foreground"
          >
            ✓ Done ({done.length}) →
          </button>
        </div>
      )}

      <DoneDialog open={doneOpen} done={done} onClose={() => setDoneOpen(false)} />
      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
