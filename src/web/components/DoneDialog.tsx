import { useEffect, useRef, useState } from "react";
import type { Todo } from "../types.ts";
import { ago } from "../time.ts";
import { runViewTransition } from "../viewTransition.ts";

const listStyle: Record<string, string> = { viewTransitionName: "vt-donelist" };

const PAGE_SIZE = 10;

export function DoneDialog({
  open,
  done,
  onClose,
}: {
  open: boolean;
  done: Todo[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    try {
      if (open && !d.open) d.showModal();
      else if (!open && d.open) d.close();
    } catch {}
  }, [open]);

  useEffect(() => {
    if (open) setPage(0);
  }, [open]);

  const sorted = [...done].sort((a, b) => b.updated_at - a.updated_at);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clamped = Math.min(page, pageCount - 1);
  const start = clamped * PAGE_SIZE;
  const rows = sorted.slice(start, start + PAGE_SIZE);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="done-dialog-title"
      className="m-auto w-[min(40rem,92vw)] rounded-xl border border-border bg-card p-0 text-foreground shadow-card backdrop:bg-black/50"
    >
      {open && (
        <div className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="done-dialog-title" className="text-lg font-semibold">Done</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground/60 transition hover:text-foreground"
            >
              ✕
            </button>
          </div>

          {sorted.length === 0 ? (
            <div className="mt-4 text-sm text-muted-foreground">No completed todos yet.</div>
          ) : (
            <>
              <ul className="mt-4 divide-y divide-border" style={listStyle}>
                {rows.map((t) => (
                  <li key={t.id} className="py-2">
                    <div className="text-sm font-medium text-foreground line-clamp-1">{t.title}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                      {t.for_who && <span className="font-semibold text-attention">→ {t.for_who}</span>}
                      {t.branch && <span>⎇ {t.branch}</span>}
                      {t.origin_project && <span className="text-muted-foreground/70">{t.origin_project}</span>}
                      <span className="text-muted-foreground/70">done {ago(t.updated_at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => runViewTransition(() => setPage((p) => Math.max(0, p - 1)))}
                  disabled={clamped === 0}
                  className="rounded-md border border-border px-2 py-1 transition hover:text-foreground disabled:opacity-40"
                >
                  Prev
                </button>
                <span>{start + 1}–{start + rows.length} of {sorted.length}</span>
                <button
                  type="button"
                  onClick={() => runViewTransition(() => setPage((p) => Math.min(pageCount - 1, p + 1)))}
                  disabled={clamped >= pageCount - 1}
                  className="rounded-md border border-border px-2 py-1 transition hover:text-foreground disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
