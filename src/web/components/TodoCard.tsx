import type { Todo } from "../types.ts";
import { patchTodo, deleteTodo } from "../api.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { Rail, ROW_BASE, ROW_TONE } from "./primitives.tsx";

export function TodoCard({ t, onOpen }: { t: Todo; onOpen?: (t: Todo) => void }) {
  // Stable name so marking done / deleting / adding tweens the list.
  const style: Record<string, string> = { viewTransitionName: `vt-t-${t.id}` };
  return (
    <div
      onClick={() => onOpen?.(t)}
      style={style}
      className={`am-fade-in group flex cursor-pointer items-center py-1.5 ${ROW_BASE} ${ROW_TONE.default}`}
    >
      <Rail>
        <button
          type="button"
          className="am-check inline-flex h-4 w-4 shrink-0 items-center justify-center text-ink-4 transition-colors duration-quick ease-quad hover:text-done"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            patchTodo(t.id, { status: "done" });
          }}
          aria-label="Mark done"
          title="Mark done"
        >
          <StatusGlyph kind="todo" />
        </button>
      </Rail>

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {/* one-line rows want truncation, not line-clamp-2 */}
        <span className="max-w-[46%] truncate text-sm font-medium text-ink">{t.title}</span>
        {t.note && (
          <span data-testid="note" className="line-clamp-1 min-w-0 flex-1 text-xs text-ink-4">
            {t.note}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2.5 text-2xs">
          {t.for_who && <span className="font-medium text-attention">→ {t.for_who}</span>}
          {t.branch && <span className="text-ink-4">⎇ {t.branch}</span>}
          {t.origin_project && <span className="text-ink-4">{t.origin_project}</span>}
        </div>
        {/* stays in the DOM - opacity does not affect getByLabelText */}
        <button
          type="button"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-hairline border-transparent text-2xs leading-none text-ink-4 opacity-0 transition-opacity duration-quick ease-quad group-focus-within:opacity-100 group-hover:opacity-100 hover:border-danger/40 hover:bg-danger/[0.12] hover:text-danger"
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
  );
}
