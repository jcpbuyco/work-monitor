import { useEffect, useRef } from "react";
import type { Todo } from "../types.ts";

export function TodoModal({ todo, onClose }: { todo: Todo | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    try {
      if (todo && !d.open) d.showModal();
      else if (!todo && d.open) d.close();
    } catch {}
  }, [todo]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="todo-modal-title"
      className="m-auto w-[min(40rem,92vw)] rounded-xl border border-border bg-card p-0 text-foreground shadow-card backdrop:bg-black/50"
    >
      {todo && (
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 id="todo-modal-title" className="text-lg font-semibold">{todo.title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground/60 transition hover:text-foreground"
            >
              ✕
            </button>
          </div>
          {todo.note && (
            <div className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm text-muted-foreground">
              {todo.note}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {todo.for_who && <span className="font-semibold text-attention">→ {todo.for_who}</span>}
            {todo.branch && <span className="text-muted-foreground">⎇ {todo.branch}</span>}
            {todo.origin_project && <span className="text-muted-foreground/70">{todo.origin_project}</span>}
          </div>
          {todo.links && todo.links.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {todo.links.map((l, i) => (
                <li key={i}>
                  {/^https?:\/\//.test(l) ? (
                    <a href={l} target="_blank" rel="noreferrer" className="text-primary hover:underline">{l}</a>
                  ) : (
                    <span className="text-muted-foreground">{l}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </dialog>
  );
}
