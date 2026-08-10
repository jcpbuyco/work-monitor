import { useState } from "react";
import type { Todo } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { SectionHeader } from "./primitives.tsx";
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
    <section className="mt-6">
      <SectionHeader
        label={`★ Todos (${open.length})`}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        right={
          <>
            <span className="text-2xs text-ink-4">✓ to complete · ✕ to delete</span>
            <button
              type="button"
              data-testid="todos-done-link"
              onClick={() => setDoneOpen(true)}
              className="text-2xs font-semibold text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
            >
              ✓ Done ({done.length}) →
            </button>
          </>
        }
      />

      {!collapsed && (
        <div className="am-fade-in">
          {open.length === 0 ? (
            <div className="py-3 text-xs text-ink-4">Nothing open. 🎉</div>
          ) : (
            <div data-testid="todos-scroller" className="max-h-[40vh] overflow-y-auto pr-1">
              {/* the columns-1 sm:columns-2 xl:columns-3 masonry is deleted */}
              {open.map((t) => (
                <TodoCard key={t.id} t={t} onOpen={setSelected} />
              ))}
            </div>
          )}
        </div>
      )}

      <DoneDialog open={doneOpen} done={done} onClose={() => setDoneOpen(false)} />
      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
