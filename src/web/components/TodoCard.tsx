import { useDraggable } from "@dnd-kit/core";
import type { Todo } from "../types.ts";
import { deleteTodo } from "../api.ts";

export function TodoCard({ t, onOpen }: { t: Todo; onOpen?: (t: Todo) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: t.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.6 : 1 }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={() => onOpen?.(t)}
      className="mb-2 cursor-grab rounded-lg border border-border bg-card p-3 shadow-card transition hover:bg-card-hover hover:shadow-card-hover"
    >
      <div className="flex justify-between gap-2">
        <div className="font-medium text-foreground line-clamp-2">{t.title}</div>
        <button
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
      {t.note && <div className="mt-1 line-clamp-4 text-xs text-muted-foreground">{t.note}</div>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs">
        {t.for_who && <span className="font-semibold text-attention">→ {t.for_who}</span>}
        {t.branch && <span className="text-muted-foreground">⎇ {t.branch}</span>}
        {t.origin_project && <span className="text-muted-foreground/70">{t.origin_project}</span>}
      </div>
    </div>
  );
}
