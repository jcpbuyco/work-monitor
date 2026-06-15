import type { Todo } from "../types.ts";
import { patchTodo, deleteTodo } from "../api.ts";

export function TodoCard({ t, onOpen }: { t: Todo; onOpen?: (t: Todo) => void }) {
  return (
    <div
      onClick={() => onOpen?.(t)}
      className="mb-2 cursor-pointer rounded-lg border border-border bg-card p-3 shadow-card transition hover:bg-card-hover hover:shadow-card-hover"
    >
      <div className="flex justify-between gap-2">
        <div className="font-medium text-foreground line-clamp-2">{t.title}</div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="text-xs text-muted-foreground/40 transition hover:text-done focus-visible:text-done"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              patchTodo(t.id, { status: "done" });
            }}
            aria-label="Mark done"
          >
            ✓
          </button>
          <button
            type="button"
            className="text-xs text-muted-foreground/40 transition hover:text-red-400 focus-visible:text-red-400"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              deleteTodo(t.id);
            }}
            aria-label="Delete"
          >
            ✕
          </button>
        </div>
      </div>
      {t.note && <div className="mt-1 line-clamp-4 text-xs text-muted-foreground">{t.note}</div>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs">
        {t.for_who && <span className="font-semibold text-attention">→ {t.for_who}</span>}
        {t.branch && <span className="text-muted-foreground">⎇ {t.branch}</span>}
        {t.origin_project && <span className="text-muted-foreground/70">{t.origin_project}</span>}
      </div>
    </div>
  );
}
