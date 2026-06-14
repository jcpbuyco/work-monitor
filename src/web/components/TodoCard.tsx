import { useDraggable } from "@dnd-kit/core";
import type { Todo } from "../types.ts";
import { deleteTodo } from "../api.ts";

export function TodoCard({ t }: { t: Todo }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: t.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.6 : 1 }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group mb-2 cursor-grab rounded-lg border border-border bg-card p-3 shadow-card transition hover:bg-card-hover hover:shadow-card-hover"
    >
      <div className="flex justify-between gap-2">
        <div className="font-medium text-foreground" {...listeners} {...attributes}>
          {t.title}
        </div>
        <button
          className="text-xs text-muted-foreground/50 opacity-0 transition hover:text-red-400 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => deleteTodo(t.id)}
          aria-label="Delete"
        >
          ✕
        </button>
      </div>
      {t.note && <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{t.note}</div>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {t.for_who && <span className="font-semibold text-attention">→ {t.for_who}</span>}
        {t.branch && <span className="text-muted-foreground">⎇ {t.branch}</span>}
        {t.origin_project && <span className="text-muted-foreground/70">{t.origin_project}</span>}
      </div>
    </div>
  );
}
