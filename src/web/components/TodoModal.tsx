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
      /* the backdrop is theme-aware in styles.css now - no backdrop: utility */
      className="m-auto w-[min(35rem,100vw-2rem)] rounded-xl border-hairline border-border bg-surface-1 p-0 text-ink shadow-pop"
    >
      {todo && (
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 id="todo-modal-title" className="text-base font-semibold">{todo.title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
            >
              ✕
            </button>
          </div>
          {todo.note && (
            <div className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm text-ink-2">
              {todo.note}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
            {todo.for_who && <span className="font-medium text-attention">→ {todo.for_who}</span>}
            {todo.branch && <span>⎇ {todo.branch}</span>}
            {todo.origin_project && <span className="text-ink-4">{todo.origin_project}</span>}
          </div>
          {todo.links && todo.links.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {todo.links.map((l, i) => (
                <li key={i}>
                  {/^https?:\/\//.test(l) ? (
                    <a
                      href={l}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent transition-colors duration-quick ease-quad hover:text-accent-hover"
                    >
                      {l}
                    </a>
                  ) : (
                    <span className="text-ink-3">{l}</span>
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
