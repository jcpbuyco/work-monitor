# Collapsible to-do list + Done dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-column todos kanban with a single, collapsible open-to-do list plus a ✓ "mark done" button per card and a paginated, latest-first **Done** dialog, and delete the now-unused `@dnd-kit` drag machinery.

**Architecture:** Web-only change (`src/web/`). The server already returns every todo (with `updated_at`) in `/api/state`, so the Done dialog sorts/paginates client-side. A new `TodosSection` component owns the whole todos UI (collapse header + open list + Done link + the `DoneDialog` + the existing `TodoModal`), replacing the todos `<Lane>` in `Board`. Drag-to-Done is replaced by a per-card ✓ button calling the existing `patchTodo(id, { status: "done" })`; all `@dnd-kit` usage (`DndContext`/`useDraggable`/`useDroppable`, `drag.ts`) is removed.

**Tech Stack:** React 18 + TypeScript, Tailwind (hand-rolled shadcn tokens), Vite, Vitest + Testing Library (jsdom), Bun.

**Conventions observed in this repo (follow them):**
- This Vitest setup runs **without** `globals: true` — every test imports `describe/it/expect/...` from `"vitest"` explicitly, and `web-tests/setup.ts` registers `afterEach(cleanup)` for RTL.
- Tailwind has semantic tokens incl. `done`, `attention`, `working`, `idle`, `muted-foreground`, `chip`, `card`, plus a `text-2xs` (`0.6875rem`) font-size token. Use these — don't hardcode hex/px.
- `tsconfig.web.json` includes **both** `src/web` and `web-tests`, so `bun run typecheck` type-checks the tests too: any Todo object literal must satisfy the full `Todo` type.
- Native `<dialog>` open/close pattern (see `TodoModal.tsx`): drive `showModal()`/`close()` from an effect wrapped in `try/catch`; close on `onClose` (Esc), backdrop click (`e.target === ref.current`), and an explicit ✕ button.

**Verification commands (used throughout):**
- `cd /home/lunatic/projects/work/work-monitor`
- Tests: `bun run web:test` (Vitest). Single file: `bun run web:test -- web-tests/<file>` .
- Types: `bun run typecheck`
- Build: `bun run web:build`

**Why every commit stays green:** `Todo.updated_at` is added (Task 3) as the single cross-cutting change, and all existing fixtures are patched in that same task. dnd is unwired from components (Tasks 5–7) before the dependency and files are deleted (Task 8), so no commit has a dangling import.

---

### Task 1: `usePersistedToggle` hook

A localStorage-backed boolean toggle whose initial render already reflects the saved value (no flicker). Mirrors the `useState(initializer)` + `try/catch` pattern in `useTextSize.ts`.

**Files:**
- Create: `src/web/usePersistedToggle.ts`
- Test: `web-tests/usePersistedToggle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-tests/usePersistedToggle.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedToggle } from "../src/web/usePersistedToggle.ts";

beforeEach(() => localStorage.clear());

describe("usePersistedToggle", () => {
  it("defaults to false", () => {
    const { result } = renderHook(() => usePersistedToggle("k"));
    expect(result.current[0]).toBe(false);
  });

  it("respects an explicit initial value", () => {
    const { result } = renderHook(() => usePersistedToggle("k", true));
    expect(result.current[0]).toBe(true);
  });

  it("reads a stored value over the initial", () => {
    localStorage.setItem("k", "true");
    const { result } = renderHook(() => usePersistedToggle("k", false));
    expect(result.current[0]).toBe(true);
  });

  it("toggles and persists", () => {
    const { result } = renderHook(() => usePersistedToggle("k"));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("k")).toBe("true");
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem("k")).toBe("false");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run web:test -- web-tests/usePersistedToggle.test.ts`
Expected: FAIL — cannot resolve `../src/web/usePersistedToggle.ts` (module does not exist).

- [ ] **Step 3: Write the hook**

Create `src/web/usePersistedToggle.ts`:

```ts
import { useCallback, useState } from "react";

/** A localStorage-backed boolean toggle. Reads the stored value in the
 *  useState initializer so the first render already reflects it (no flicker). */
export function usePersistedToggle(key: string, initial = false): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "true") return true;
      if (v === "false") return false;
    } catch {}
    return initial;
  });

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, String(next));
      } catch {}
      return next;
    });
  }, [key]);

  return [on, toggle];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run web:test -- web-tests/usePersistedToggle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/usePersistedToggle.ts web-tests/usePersistedToggle.test.ts
git commit -m "feat(web): add usePersistedToggle hook"
```

---

### Task 2: Extract `ago()` into `src/web/time.ts`

`ago()` currently lives inside `SessionCard.tsx`. Extract it verbatim into a shared module so `DoneDialog` (Task 4) can reuse it, and point `SessionCard` at it. Pure refactor — no behavior change. `SessionCard.test.tsx` continues to pass and is our regression guard.

**Files:**
- Create: `src/web/time.ts`
- Modify: `src/web/components/SessionCard.tsx` (remove local `ago`, import from `../time.ts`)

- [ ] **Step 1: Create the shared helper**

Create `src/web/time.ts` (body identical to the current `SessionCard` implementation):

```ts
/** Relative "time ago" label for a past epoch-ms timestamp. */
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
```

- [ ] **Step 2: Point `SessionCard` at it**

In `src/web/components/SessionCard.tsx`:

Replace the top import line:

```tsx
import type { Session } from "../types.ts";
```

with:

```tsx
import type { Session } from "../types.ts";
import { ago } from "../time.ts";
```

Then delete the local `ago` function (the whole block):

```tsx
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
```

Leave the rest of `SessionCard` (including the `ago(s.last_activity_at)` call) untouched.

- [ ] **Step 3: Verify the refactor is transparent**

Run: `bun run web:test -- web-tests/SessionCard.test.tsx`
Expected: PASS (2 tests — branch shown / branch omitted).

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/web/time.ts src/web/components/SessionCard.tsx
git commit -m "refactor(web): extract ago() into shared time.ts"
```

---

### Task 3: Add `Todo.updated_at` and patch all existing fixtures

`updated_at` already comes back from `/api/state` (server `TODO_COLS` includes it); the web `Todo` type just needs to declare it for sorting + relative time. Adding it as a **required** field forces every Todo object literal in the test suite to include it (because `web-tests` is type-checked). Patch them all here so typecheck + tests stay green. (Two of these fixtures — `TodoCard.test.tsx`, `drag.test.ts` — are rewritten/deleted later; adding the field now keeps this commit green and is harmless.)

**Files:**
- Modify: `src/web/types.ts:16-26` (the `Todo` interface)
- Modify: `web-tests/Board.test.tsx`, `web-tests/AppBar.test.tsx`, `web-tests/TodoModal.test.tsx`, `web-tests/TodoCard.test.tsx`, `web-tests/drag.test.ts`

- [ ] **Step 1: Add the field to the `Todo` type**

In `src/web/types.ts`, add `updated_at: number;` to the `Todo` interface (place it after `position`):

```ts
export interface Todo {
  id: string;
  title: string;
  note: string;
  for_who: string | null;
  status: TodoStatus;
  origin_project: string | null;
  branch: string | null;
  links: string[] | null;
  position: number;
  updated_at: number;
}
```

- [ ] **Step 2: Run typecheck to see the fixtures fail**

Run: `bun run typecheck`
Expected: FAIL — several `web-tests/*.tsx|ts` errors of the form `Property 'updated_at' is missing in type ... but required in type 'Todo'`.

- [ ] **Step 3: Patch every fixture**

`web-tests/Board.test.tsx` — add `updated_at` to the single todo literal:

```tsx
  todos: [
    { id: "t1", title: "Hand off spec", note: "branch feat/pay", for_who: "Maria", status: "todo", origin_project: "bov", branch: "feat/pay", links: null, position: 0, updated_at: Date.now() },
  ],
```

`web-tests/AppBar.test.tsx` — add `updated_at` to the single todo literal:

```tsx
  todos: [
    { id: "t1", title: "t", note: "", for_who: null, status: "todo", origin_project: null, branch: null, links: null, position: 0, updated_at: 0 },
  ],
```

`web-tests/TodoModal.test.tsx` — add `updated_at` to the `todo` literal:

```tsx
const todo: Todo = {
  id: "t1", title: "Full Title", note: "Line one\nLine two", for_who: "Sam",
  status: "todo", origin_project: "proj", branch: "feat/x", links: ["docs/spec.md"], position: 0, updated_at: 0,
};
```

`web-tests/TodoCard.test.tsx` — add `updated_at` to the `todo` literal (this file is fully rewritten in Task 5; this one-line edit just keeps the build green now):

```tsx
const todo: Todo = {
  id: "t1", title: "Card Title", note: "a clamped note", for_who: "Sam",
  status: "todo", origin_project: "p", branch: "b", links: null, position: 0, updated_at: 0,
};
```

`web-tests/drag.test.ts` — add `updated_at` to the `todo()` factory (this file is deleted in Task 8; edit keeps the build green now):

```ts
const todo = (id: string, status: Todo["status"]): Todo => ({
  id, title: id, note: "", for_who: null, status,
  origin_project: null, branch: null, links: null, position: 0, updated_at: 0,
});
```

- [ ] **Step 4: Verify green**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run web:test`
Expected: PASS (all existing suites still green).

- [ ] **Step 5: Commit**

```bash
git add src/web/types.ts web-tests/Board.test.tsx web-tests/AppBar.test.tsx web-tests/TodoModal.test.tsx web-tests/TodoCard.test.tsx web-tests/drag.test.ts
git commit -m "feat(web): add updated_at to the Todo type and fixtures"
```

---

### Task 4: `DoneDialog` component

A native `<dialog>` listing completed todos, sorted latest-first by `updated_at`, paginated client-side (10/page) with Prev/Next + an `X–Y of M` indicator. Inner content is gated on `open` (like `TodoModal` gates on `todo`) so nothing leaks into the DOM while closed.

**Files:**
- Create: `src/web/components/DoneDialog.tsx`
- Test: `web-tests/DoneDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web-tests/DoneDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DoneDialog } from "../src/web/components/DoneDialog.tsx";
import type { Todo } from "../src/web/types.ts";

const mk = (id: string, updated_at: number): Todo => ({
  id, title: id, note: "", for_who: null, status: "done",
  origin_project: null, branch: null, links: null, position: 0, updated_at,
});

describe("DoneDialog", () => {
  it("renders done todos latest-first", () => {
    const done = [mk("old", 1000), mk("new", 3000), mk("mid", 2000)];
    render(<DoneDialog open done={done} onClose={() => {}} />);
    const titles = screen.getAllByText(/^(old|new|mid)$/).map((e) => e.textContent);
    expect(titles).toEqual(["new", "mid", "old"]);
  });

  it("paginates with Prev/Next bounds", () => {
    // 12 items; updated_at 1000..1011 so t11 is newest. Sorted desc: t11..t0.
    const done = Array.from({ length: 12 }, (_, i) => mk(`t${i}`, 1000 + i));
    render(<DoneDialog open done={done} onClose={() => {}} />);
    expect(screen.getByText("1–10 of 12")).toBeDefined();
    expect(screen.queryByText("t1")).toBeNull(); // t1, t0 are on page 2
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("11–12 of 12")).toBeDefined();
    expect(screen.getByText("t1")).toBeDefined();
    expect(screen.getByText("t0")).toBeDefined();
  });

  it("shows an empty state when there are no done todos", () => {
    render(<DoneDialog open done={[]} onClose={() => {}} />);
    expect(screen.getByText("No completed todos yet.")).toBeDefined();
  });

  it("calls onClose when ✕ is clicked", () => {
    const onClose = vi.fn();
    render(<DoneDialog open done={[mk("a", 1)]} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run web:test -- web-tests/DoneDialog.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/DoneDialog.tsx`.

- [ ] **Step 3: Write the component**

Create `src/web/components/DoneDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { Todo } from "../types.ts";
import { ago } from "../time.ts";

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
              <ul className="mt-4 divide-y divide-border">
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
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={clamped === 0}
                  className="rounded-md border border-border px-2 py-1 transition hover:text-foreground disabled:opacity-40"
                >
                  Prev
                </button>
                <span>{start + 1}–{start + rows.length} of {sorted.length}</span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run web:test -- web-tests/DoneDialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/components/DoneDialog.tsx web-tests/DoneDialog.test.tsx
git commit -m "feat(web): add paginated latest-first DoneDialog"
```

---

### Task 5: Rewrite `TodoCard` — drop drag, add ✓ "mark done"

The card becomes a plain clickable `<div>` (open detail modal) with two stop-propagation buttons: **✓ Mark done** (`patchTodo(id, { status: "done" })`) and the existing **✕ Delete**. No `useDraggable`, no `cursor-grab`.

**Files:**
- Modify: `src/web/components/TodoCard.tsx` (full rewrite)
- Test: `web-tests/TodoCard.test.tsx` (full rewrite — drop the `DndContext` wrapper, add the ✓ + not-draggable tests)

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `web-tests/TodoCard.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodoCard } from "../src/web/components/TodoCard.tsx";
import type { Todo } from "../src/web/types.ts";

const patchTodo = vi.fn();
const deleteTodo = vi.fn();
vi.mock("../src/web/api.ts", () => ({
  patchTodo: (...a: any[]) => patchTodo(...a),
  deleteTodo: (...a: any[]) => deleteTodo(...a),
}));

const todo: Todo = {
  id: "t1", title: "Card Title", note: "a clamped note", for_who: "Sam",
  status: "todo", origin_project: "p", branch: "b", links: null, position: 0, updated_at: 0,
};

beforeEach(() => {
  patchTodo.mockClear();
  deleteTodo.mockClear();
});

function renderCard() {
  const onOpen = vi.fn();
  const r = render(<TodoCard t={todo} onOpen={onOpen} />);
  return { onOpen, ...r };
}

describe("TodoCard", () => {
  it("clicking the card opens the todo", () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByText("Card Title"));
    expect(onOpen).toHaveBeenCalledWith(todo);
  });

  it("clicking ✓ marks it done and does not open the todo", () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByLabelText("Mark done"));
    expect(patchTodo).toHaveBeenCalledWith("t1", { status: "done" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicking delete deletes and does not open the todo", () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(deleteTodo).toHaveBeenCalledWith("t1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clamps the note to 4 lines", () => {
    renderCard();
    expect(screen.getByText("a clamped note").className).toContain("line-clamp-4");
  });

  it("is not draggable (no drag affordance)", () => {
    const { container } = renderCard();
    expect(container.querySelector(".cursor-grab")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run web:test -- web-tests/TodoCard.test.tsx`
Expected: FAIL — "Mark done" label not found (✓ button doesn't exist yet) and/or `cursor-grab` still present.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `src/web/components/TodoCard.tsx` with:

```tsx
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run web:test -- web-tests/TodoCard.test.tsx`
Expected: PASS (5 tests).

Note: `Board` still wraps `TodoCard` in a `DndContext` at this point — that's fine, a non-draggable child renders normally inside a `DndContext`. `bun run typecheck` still passes.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/TodoCard.tsx web-tests/TodoCard.test.tsx
git commit -m "feat(web): TodoCard ✓ mark-done button, drop drag"
```

---

### Task 6: `TodosSection` component

Owns the entire todos UI: a collapsible header (`★ Todos (N) ▾/▸`, persisted via `usePersistedToggle("wm-todos-collapsed")`), the open-todo list, a `✓ Done (M) →` link that opens the `DoneDialog`, plus the `TodoModal` for card detail. Not yet wired into `Board` (Task 7) — its test renders it directly.

**Files:**
- Create: `src/web/components/TodosSection.tsx`
- Test: `web-tests/TodosSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web-tests/TodosSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodosSection } from "../src/web/components/TodosSection.tsx";
import type { Todo } from "../src/web/types.ts";

vi.mock("../src/web/api.ts", () => ({ patchTodo: vi.fn(), deleteTodo: vi.fn() }));

const mk = (id: string, status: Todo["status"]): Todo => ({
  id, title: id, note: "", for_who: null, status,
  origin_project: null, branch: null, links: null, position: 0, updated_at: 0,
});

const todos = [mk("open1", "todo"), mk("open2", "todo"), mk("gone", "done")];

beforeEach(() => localStorage.clear());

describe("TodosSection", () => {
  it("shows the open todos and a Done count, but renders no done cards", () => {
    render(<TodosSection todos={todos} />);
    expect(screen.getByText("open1")).toBeDefined();
    expect(screen.getByText("open2")).toBeDefined();
    expect(screen.queryByText("gone")).toBeNull();
    expect(screen.getByText(/Done \(1\)/)).toBeDefined();
  });

  it("collapsing hides the open list", () => {
    render(<TodosSection todos={todos} />);
    fireEvent.click(screen.getByRole("button", { name: /Todos/ }));
    expect(screen.queryByText("open1")).toBeNull();
  });

  it("opening the Done link reveals the completed todo in the dialog", () => {
    render(<TodosSection todos={todos} />);
    expect(screen.queryByText("gone")).toBeNull();
    fireEvent.click(screen.getByText(/Done \(1\)/));
    expect(screen.getByText("gone")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run web:test -- web-tests/TodosSection.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/TodosSection.tsx`.

- [ ] **Step 3: Write the component**

Create `src/web/components/TodosSection.tsx`:

```tsx
import { useState } from "react";
import type { Todo } from "../types.ts";
import { usePersistedToggle } from "../usePersistedToggle.ts";
import { TodoCard } from "./TodoCard.tsx";
import { TodoModal } from "./TodoModal.tsx";
import { DoneDialog } from "./DoneDialog.tsx";

export function TodosSection({ todos }: { todos: Todo[] }) {
  const [collapsed, toggleCollapsed] = usePersistedToggle("wm-todos-collapsed");
  const [doneOpen, setDoneOpen] = useState(false);
  const [selected, setSelected] = useState<Todo | null>(null);

  const open = todos.filter((t) => t.status === "todo");
  const done = todos.filter((t) => t.status === "done");

  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          ★ Todos ({open.length})
        </button>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">
          ✓ to complete · ✕ to delete
        </span>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            {open.length === 0 ? (
              <div className="rounded-xl border border-border bg-card/50 p-4 text-2xs text-muted-foreground">
                Nothing open. 🎉
              </div>
            ) : (
              open.map((t) => <TodoCard key={t.id} t={t} onOpen={setSelected} />)
            )}
            <button
              type="button"
              onClick={() => setDoneOpen(true)}
              className="mt-1 text-2xs font-semibold text-muted-foreground transition hover:text-foreground"
            >
              ✓ Done ({done.length}) →
            </button>
          </div>
        </div>
      )}

      <DoneDialog open={doneOpen} done={done} onClose={() => setDoneOpen(false)} />
      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run web:test -- web-tests/TodosSection.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/components/TodosSection.tsx web-tests/TodosSection.test.tsx
git commit -m "feat(web): collapsible TodosSection with Done link"
```

---

### Task 7: Wire `TodosSection` into `Board`; strip dnd from `Board` + `Lane`

Replace the todos `<Lane>`/`DndContext` in `Board` with `<TodosSection>`, and make `Column` purely presentational (drop `useDroppable`/`isOver`/`droppable`/`id`). After this task no source file imports `@dnd-kit` (verified in a step) — but `drag.ts`, `drag.test.ts`, and the `@dnd-kit` deps still exist; they're removed in Task 8.

**Files:**
- Modify: `src/web/components/Board.tsx` (full rewrite)
- Modify: `src/web/components/Lane.tsx` (`Column`: drop dnd; `Lane`: unchanged)
- Modify: `web-tests/Board.test.tsx` (add a Done-link assertion)

- [ ] **Step 1: Update the Board test**

In `web-tests/Board.test.tsx`, add one assertion to the existing test body (there are 0 done todos in the fixture, so the link reads `Done (0)`). After the `expect(screen.getByText("→ Maria")).toBeDefined();` line, add:

```tsx
    expect(screen.getByText(/Done \(0\)/)).toBeDefined();
```

(The fixture's todo already gained `updated_at` in Task 3, and the api mock already stubs `patchTodo`/`deleteTodo`.)

- [ ] **Step 2: Run the Board test to verify it fails**

Run: `bun run web:test -- web-tests/Board.test.tsx`
Expected: FAIL — `Done (0)` not found (Board still renders the old two-column kanban).

- [ ] **Step 3: Make `Column` presentational (drop dnd)**

Replace the entire contents of `src/web/components/Lane.tsx` with:

```tsx
import type { ReactNode } from "react";

export function Column({
  title,
  count,
  dot,
  children,
}: {
  title: string;
  count: number;
  dot: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-2.5">
      <div className="mb-2 flex items-center justify-between px-1 py-0.5">
        <span className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {title}
        </span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-2xs text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-2xs text-muted-foreground">{hint}</span>
      </div>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">{children}</div>
    </section>
  );
}
```

- [ ] **Step 4: Rewrite `Board` to use `TodosSection` + the new `Column` API**

Replace the entire contents of `src/web/components/Board.tsx` with:

```tsx
import type { State, Session } from "../types.ts";
import { Lane, Column } from "./Lane.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodosSection } from "./TodosSection.tsx";

const SESSION_COLS: { id: Session["status"]; title: string; dot: string }[] = [
  { id: "working", title: "Working", dot: "bg-working" },
  { id: "needs_you", title: "Needs you", dot: "bg-attention" },
  { id: "idle", title: "Idle / done", dot: "bg-idle" },
];

export function Board({ state }: { state: State }) {
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <AppBar state={state} />

      <TodosSection todos={state.todos} />

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => {
          const items = bySession(c.id);
          return (
            <Column key={c.id} title={c.title} dot={c.dot} count={items.length}>
              {items.map((s) => (
                <SessionCard key={s.id} s={s} />
              ))}
            </Column>
          );
        })}
      </Lane>
    </div>
  );
}
```

- [ ] **Step 5: Verify no `@dnd-kit` imports remain in `src/`**

Run: `grep -rn "@dnd-kit" src/`
Expected: **no output** (all source imports gone; only `package.json` and `web-tests/drag.test.ts`'s transitive `drag.ts` remain — neither imports `@dnd-kit` directly, so grep over `src/` is empty).

- [ ] **Step 6: Run tests + typecheck**

Run: `bun run web:test`
Expected: PASS — all suites, including the updated `Board.test.tsx` (`Done (0)` now present) and `TodosSection`/`DoneDialog`/`TodoCard`.

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/components/Board.tsx src/web/components/Lane.tsx web-tests/Board.test.tsx
git commit -m "feat(web): board uses TodosSection; drop dnd from Board+Column"
```

---

### Task 8: Delete the drag machinery and remove the `@dnd-kit` dependency

Nothing imports `drag.ts` or `@dnd-kit` anymore. Delete `drag.ts` + its test, drop both `@dnd-kit` packages from `package.json`, and refresh the lockfile.

**Files:**
- Delete: `src/web/drag.ts`, `web-tests/drag.test.ts`
- Modify: `package.json` (remove `@dnd-kit/core`, `@dnd-kit/sortable` from `devDependencies`)

- [ ] **Step 1: Delete the drag files**

```bash
git rm src/web/drag.ts web-tests/drag.test.ts
```

- [ ] **Step 2: Remove the deps from `package.json`**

In `package.json`, delete these two lines from `devDependencies`:

```json
    "@dnd-kit/core": "^6.1.0",
    "@dnd-kit/sortable": "^8.0.0",
```

(`@dnd-kit/sortable` was already unused; `@dnd-kit/core` is now unimported — confirmed by `grep -rn "@dnd-kit" src web-tests` returning nothing after Step 1.)

- [ ] **Step 3: Refresh the lockfile**

Run: `bun install`
Expected: completes; `bun.lock` updated to drop the `@dnd-kit` packages.

- [ ] **Step 4: Full verification**

Run: `grep -rn "@dnd-kit" src web-tests`
Expected: **no output.**

Run: `bun run web:test`
Expected: PASS — all suites green (`usePersistedToggle`, `DoneDialog`, `TodosSection`, `TodoCard`, `Board`, `AppBar`, `TodoModal`, `SessionCard`, `useTheme`, `useTextSize`). No `drag.test.ts`.

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run web:build`
Expected: succeeds, emits `dist/web`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(web): remove @dnd-kit and the unused drag module"
```

---

### Task 9: Manual smoke check + docs

- [ ] **Step 1: Build and view against the real backend**

Per the project's dev gotcha, `web:dev` renders blank (vite proxy shadows `api.ts`); view the rebuilt bundle through the running `:4317` backend instead.

Run: `bun run web:build`
Then open `http://localhost:4317/` and confirm:
- `★ Todos (N) ▾` header collapses/expands and the state survives a reload (localStorage `wm-todos-collapsed`).
- Each open card has a ✓ (mark done) and ✕ (delete); clicking ✓ moves the todo off the open list on the next SSE refresh.
- `✓ Done (M) →` opens the dialog, latest-first, Prev/Next paginate, ✕/Esc/backdrop close it.
- The sessions lane still renders normally and the board fits one page even with many done todos.

(No server restart needed — this is web-only; the `:4317` server serves the rebuilt `dist/web`, so just reload the tab.)

- [ ] **Step 2: Mark the spec implemented**

Append a status line to `docs/superpowers/specs/2026-06-15-collapsible-todos-done-dialog-design.md` noting it was implemented (date, plan reference), matching how prior specs in this repo were closed out.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-15-collapsible-todos-done-dialog-design.md
git commit -m "docs: mark collapsible-todos-done-dialog spec implemented"
```

---

## Self-Review

**Spec coverage:**
- §1 Layout + collapse (`TodosSection`, `usePersistedToggle`, `wm-todos-collapsed`, header `★ Todos (N) ▾/▸`, dropped drag hint) → Tasks 1, 6, 7.
- §2 Mark done (✓ button, stopPropagation, `patchTodo(id,{status:"done"})`, modal still opens, ✕ still deletes) → Task 5.
- §3 Done dialog (`DoneDialog`, native `<dialog>`, props `{open,done,onClose}`, `updated_at` desc, `PAGE_SIZE=10`, page reset on open, Prev/Next + `X–Y of M`, compact rows, empty state) → Task 4 (wired in Task 6).
- §4 Remove dnd (`TodoCard`, `Column`, `Board`, delete `drag.ts`/`drag.test.ts`, drop `@dnd-kit/core` + `@dnd-kit/sortable`, `bun install`) → Tasks 5, 7, 8.
- §5 Data (`Todo.updated_at`, extract `ago` into `time.ts`, no api changes) → Tasks 2, 3.
- §6 Files (new/modify/delete lists) → covered across Tasks 1–8.
- §7 Testing (`usePersistedToggle`, `TodoCard`, `DoneDialog`, `TodosSection`, `Board`, full `web:test`+`typecheck`+`web:build`) → Tasks 1, 4, 5, 6, 7, 8.
- §8 Non-goals respected: no backend/DB/API/SSE changes; done dialog read-only; client-side pagination; no sessions-lane collapse.

**Placeholder scan:** none — every code/test step contains full content; commands have expected output.

**Type/name consistency:** `usePersistedToggle(key, initial=false): [boolean, () => void]`, `ago(ts:number)`, `DoneDialog({open,done,onClose})`, `TodosSection({todos})`, `TodoCard({t,onOpen})`, `patchTodo(id,{status})`, `Todo.updated_at:number` are used identically across tasks. `Column` loses `id`/`droppable`/`useDroppable` in Task 7 and every `<Column>` call site (Board sessions) is updated in the same task. Every Todo fixture (incl. new tests) carries `updated_at`.
