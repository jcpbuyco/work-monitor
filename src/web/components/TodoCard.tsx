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
      className="rounded-md border border-slate-800 bg-slate-900 p-3 mb-2 cursor-grab"
    >
      <div className="flex justify-between gap-2">
        <div className="font-semibold text-slate-100" {...listeners} {...attributes}>{t.title}</div>
        <button className="text-slate-600 hover:text-red-400 text-xs" onClick={() => deleteTodo(t.id)}>✕</button>
      </div>
      {t.note && <div className="text-xs text-slate-400 mt-1 whitespace-pre-wrap">{t.note}</div>}
      <div className="text-[10px] mt-2 space-x-2">
        {t.for_who && <span className="text-amber-400">→ {t.for_who}</span>}
        {t.branch && <span className="text-slate-500">⎇ {t.branch}</span>}
        {t.origin_project && <span className="text-slate-600">{t.origin_project}</span>}
      </div>
    </div>
  );
}
