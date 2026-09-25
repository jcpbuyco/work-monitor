import { useEffect, useRef, useState } from "react";
import type { Todo } from "../types.ts";
import { ago } from "../time.ts";
import { runViewTransition } from "../viewTransition.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

const listStyle: Record<string, string> = { viewTransitionName: "vt-donelist" };

const PAGE_SIZE = 10;

const PAGER =
  "inline-flex h-6 items-center rounded-md px-2 text-ink-3 transition-colors duration-quick ease-quad hover:bg-surface-2 hover:text-ink disabled:opacity-40";

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
      className="m-auto w-[min(35rem,100vw-2rem)] rounded-xl border-hairline border-border bg-surface-1 p-0 text-ink shadow-pop"
    >
      {open && (
        <div className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="done-dialog-title" className="text-base font-semibold">Done</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-ink-4 transition-colors duration-quick ease-quad hover:text-ink"
            >
              ✕
            </button>
          </div>

          {sorted.length === 0 ? (
            <div className="mt-4 text-sm text-ink-3">No completed todos yet.</div>
          ) : (
            <>
              {/* rows separate by rhythm - the divide-y is gone */}
              <ul className="mt-4" style={listStyle}>
                {rows.map((t) => (
                  <li key={t.id} className={`flex items-start py-1.5 ${ROW_BASE} ${ROW_TONE.default}`}>
                    <Rail>
                      <StatusGlyph kind="ended" animate={false} className="text-done" />
                    </Rail>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-1 text-sm font-medium text-ink">{t.title}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-4">
                        {t.for_who && <span className="font-medium text-attention">→ {t.for_who}</span>}
                        {t.branch && <span>⎇ {t.branch}</span>}
                        {t.origin_project && <span>{t.origin_project}</span>}
                        <span className="tabular-nums">done {ago(t.updated_at)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center justify-between text-xs text-ink-3">
                <button
                  type="button"
                  data-press
                  onClick={() => runViewTransition(() => setPage((p) => Math.max(0, p - 1)))}
                  disabled={clamped === 0}
                  className={PAGER}
                >
                  Prev
                </button>
                <span className="tabular-nums">{start + 1}–{start + rows.length} of {sorted.length}</span>
                <button
                  type="button"
                  data-press
                  onClick={() => runViewTransition(() => setPage((p) => Math.min(pageCount - 1, p + 1)))}
                  disabled={clamped >= pageCount - 1}
                  className={PAGER}
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
