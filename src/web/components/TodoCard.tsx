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
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted text-sm leading-none text-muted-foreground transition hover:border-done/40 hover:bg-done/10 hover:text-done focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-done/50"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              patchTodo(t.id, { status: "done" });
            }}
            aria-label="Mark done"
            title="Mark done"
          >
            ✓
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted text-sm leading-none text-muted-foreground transition hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              deleteTodo(t.id);
            }}
            aria-label="Delete"
            title="Delete"
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
