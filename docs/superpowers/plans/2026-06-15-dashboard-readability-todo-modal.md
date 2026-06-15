# Dashboard readability + todo detail modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented — merged to `main` (2026-06-15)

**Goal:** Add an app-bar text-size control (so the dashboard is readable on a 4K monitor) and a todo detail modal opened by clicking a card, with cards clamped to keep the board compact.

**Architecture:** A `useTextSize` hook scales the whole UI via the root `font-size` (the type scale is `rem`-based; a new `2xs` token converts the few hardcoded `px` labels). A `TodoModal` built on the native `<dialog>` element shows the full todo; clicking a card opens it, while dragging still works via a `PointerSensor` movement threshold. `src/web/` only — no server/data changes.

**Tech Stack:** React 18 + TypeScript, Tailwind v3.4 (built-in `line-clamp`), `@dnd-kit/core`, Vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-06-15-dashboard-readability-todo-modal-design.md`

---

## Task 1: Text-size control

**Files:**
- Create: `src/web/useTextSize.ts`, `web-tests/useTextSize.test.ts`
- Modify: `tailwind.config.js`, `src/web/index.html`, `src/web/components/AppBar.tsx`, `src/web/components/Lane.tsx`, `src/web/components/SessionCard.tsx`

- [ ] **Step 1: Write the failing hook test**

Create `web-tests/useTextSize.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTextSize } from "../src/web/useTextSize.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("useTextSize", () => {
  it("defaults to 16 and applies it to the root", () => {
    const { result } = renderHook(() => useTextSize());
    expect(result.current.size).toBe(16);
    expect(document.documentElement.style.fontSize).toBe("16px");
  });

  it("reads a valid stored size", () => {
    localStorage.setItem("wm-text-size", "20");
    const { result } = renderHook(() => useTextSize());
    expect(result.current.size).toBe(20);
    expect(document.documentElement.style.fontSize).toBe("20px");
  });

  it("ignores an invalid stored size", () => {
    localStorage.setItem("wm-text-size", "13");
    const { result } = renderHook(() => useTextSize());
    expect(result.current.size).toBe(16);
  });

  it("inc steps up, persists, and clamps at the max", () => {
    localStorage.setItem("wm-text-size", "20");
    const { result } = renderHook(() => useTextSize());
    act(() => result.current.inc());
    expect(result.current.size).toBe(22);
    expect(localStorage.getItem("wm-text-size")).toBe("22");
    expect(result.current.canInc).toBe(false);
    act(() => result.current.inc());
    expect(result.current.size).toBe(22);
  });

  it("dec steps down and clamps at the min", () => {
    localStorage.setItem("wm-text-size", "14");
    const { result } = renderHook(() => useTextSize());
    expect(result.current.canDec).toBe(false);
    act(() => result.current.dec());
    expect(result.current.size).toBe(14);
    act(() => result.current.inc());
    expect(result.current.size).toBe(16);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run web-tests/useTextSize.test.ts`
Expected: FAIL — cannot resolve `../src/web/useTextSize.ts`.

- [ ] **Step 3: Implement the hook**

Create `src/web/useTextSize.ts`:
```ts
import { useCallback, useEffect, useState } from "react";

const SIZES = [14, 16, 18, 20, 22];
const DEFAULT = 16;

function resolveSize(): number {
  try {
    const s = Number(localStorage.getItem("wm-text-size"));
    if (SIZES.includes(s)) return s;
  } catch {}
  return DEFAULT;
}

export function useTextSize() {
  const [size, setSize] = useState<number>(resolveSize);

  useEffect(() => {
    document.documentElement.style.fontSize = `${size}px`;
  }, [size]);

  const step = useCallback((dir: 1 | -1) => {
    setSize((prev) => {
      const i = SIZES.indexOf(prev);
      const from = i < 0 ? SIZES.indexOf(DEFAULT) : i;
      const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, from + dir))];
      try {
        localStorage.setItem("wm-text-size", String(next));
      } catch {}
      return next;
    });
  }, []);

  const inc = useCallback(() => step(1), [step]);
  const dec = useCallback(() => step(-1), [step]);
  return { size, inc, dec, canInc: size < SIZES[SIZES.length - 1], canDec: size > SIZES[0] };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run web-tests/useTextSize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the `2xs` font token**

In `tailwind.config.js`, add a `fontSize` entry to `theme.extend` (alongside `colors` and `boxShadow`):
```js
      fontSize: {
        "2xs": "0.6875rem",
      },
```

- [ ] **Step 6: Add the no-flash size script**

In `src/web/index.html`, add a second inline script in `<head>` right after the existing theme script (before `</head>`):
```html
    <script>
      (function () {
        try {
          var s = Number(localStorage.getItem('wm-text-size'));
          if ([14, 16, 18, 20, 22].indexOf(s) !== -1) document.documentElement.style.fontSize = s + 'px';
        } catch (e) {}
      })();
    </script>
```

- [ ] **Step 7: Add the A−/A+ stepper to the app bar**

Rewrite `src/web/components/AppBar.tsx` to:
```tsx
import type { State } from "../types.ts";
import { useTheme } from "../useTheme.ts";
import { useTextSize } from "../useTextSize.ts";

function Count({ dotClass, label, n }: { dotClass: string; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-chip px-2.5 py-1 text-xs text-muted-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span>{n} {label}</span>
    </span>
  );
}

export function AppBar({ state }: { state: State }) {
  const { theme, toggle } = useTheme();
  const { inc, dec, canInc, canDec } = useTextSize();
  const working = state.sessions.filter((s) => s.status === "working").length;
  const needsYou = state.sessions.filter((s) => s.status === "needs_you").length;
  const todoCount = state.todos.filter((t) => t.status === "todo").length;

  return (
    <header className="sticky top-0 z-10 -mx-4 mb-2 flex flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-2 font-semibold tracking-tight text-foreground">
        <span
          className="h-2.5 w-2.5 rounded-[3px] bg-primary"
          style={{ boxShadow: "0 0 0 3px hsl(var(--primary) / 0.18)" }}
        />
        work-monitor
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Count dotClass="bg-working" label="working" n={working} />
        <Count dotClass="bg-attention" label="needs you" n={needsYou} />
        <Count dotClass="bg-attention" label="to do" n={todoCount} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <div className="inline-flex items-center overflow-hidden rounded-lg border border-border bg-muted text-muted-foreground">
          <button
            type="button"
            onClick={dec}
            disabled={!canDec}
            aria-label="Decrease text size"
            className="px-2.5 py-1.5 text-sm transition hover:text-foreground disabled:opacity-40"
          >
            A−
          </button>
          <span className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={inc}
            disabled={!canInc}
            aria-label="Increase text size"
            className="px-2.5 py-1.5 text-base transition hover:text-foreground disabled:opacity-40"
          >
            A+
          </button>
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-label="Toggle theme"
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <span aria-hidden="true">{theme === "dark" ? "☾" : "☀"}</span>
          <span>{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 8: Swap the hardcoded label sizes to `text-2xs`**

In `src/web/components/Lane.tsx`, replace every `text-[11px]` with `text-2xs` (there are four: the column label, the column count, the lane label, and the lane hint).

In `src/web/components/SessionCard.tsx`, replace both `text-[11px]` with `text-2xs` (the status row on line 26 and the timestamp on line 40).

(Leave `TodoCard.tsx` alone here — it's rewritten in Task 2, which uses `text-2xs` directly.)

- [ ] **Step 9: Verify and commit**

Run: `bun run web:test` → expect all green (the new `useTextSize` tests + the unchanged `AppBar`/`Board`/`useTheme`/`drag` tests; the A−/A+ buttons have distinct labels and don't collide with existing queries).
Run: `bun run typecheck` → clean.
Run: `bun run web:build` → succeeds (confirms the `2xs` token + classes compile).
```bash
git add src/web tailwind.config.js web-tests
git commit -m "feat(web): app-bar text-size control (A-/A+) for 4K readability"
```

---

## Task 2: Todo clamp + detail modal

**Files:**
- Create: `src/web/components/TodoModal.tsx`, `web-tests/TodoModal.test.tsx`, `web-tests/TodoCard.test.tsx`
- Modify: `src/web/components/TodoCard.tsx`, `src/web/components/Board.tsx`

- [ ] **Step 1: Write the failing modal test**

Create `web-tests/TodoModal.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodoModal } from "../src/web/components/TodoModal.tsx";
import type { Todo } from "../src/web/types.ts";

const todo: Todo = {
  id: "t1", title: "Full Title", note: "Line one\nLine two", for_who: "Sam",
  status: "todo", origin_project: "proj", branch: "feat/x", links: ["docs/spec.md"], position: 0,
};

describe("TodoModal", () => {
  it("renders the todo's full content", () => {
    render(<TodoModal todo={todo} onClose={() => {}} />);
    expect(screen.getByText("Full Title")).toBeDefined();
    expect(screen.getByText(/Line one/)).toBeDefined();
    expect(screen.getByText("→ Sam")).toBeDefined();
    expect(screen.getByText("⎇ feat/x")).toBeDefined();
    expect(screen.getByText("proj")).toBeDefined();
    expect(screen.getByText("docs/spec.md")).toBeDefined();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<TodoModal todo={todo} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders no todo content when todo is null", () => {
    render(<TodoModal todo={null} onClose={() => {}} />);
    expect(screen.queryByText("Full Title")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run web-tests/TodoModal.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/TodoModal.tsx`.

- [ ] **Step 3: Implement the modal**

Create `src/web/components/TodoModal.tsx`:
```tsx
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
      className="m-auto w-[min(40rem,92vw)] rounded-xl border border-border bg-card p-0 text-foreground shadow-card backdrop:bg-black/50"
    >
      {todo && (
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold">{todo.title}</h2>
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run web-tests/TodoModal.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing TodoCard interaction test**

Create `web-tests/TodoCard.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TodoCard } from "../src/web/components/TodoCard.tsx";
import type { Todo } from "../src/web/types.ts";

const deleteTodo = vi.fn();
vi.mock("../src/web/api.ts", () => ({ deleteTodo: (...a: any[]) => deleteTodo(...a) }));

const todo: Todo = {
  id: "t1", title: "Card Title", note: "a clamped note", for_who: "Sam",
  status: "todo", origin_project: "p", branch: "b", links: null, position: 0,
};

beforeEach(() => deleteTodo.mockClear());

function renderCard() {
  const onOpen = vi.fn();
  render(<DndContext><TodoCard t={todo} onOpen={onOpen} /></DndContext>);
  return onOpen;
}

describe("TodoCard", () => {
  it("clicking the card opens the todo", () => {
    const onOpen = renderCard();
    fireEvent.click(screen.getByText("Card Title"));
    expect(onOpen).toHaveBeenCalledWith(todo);
  });

  it("clicking delete deletes and does not open the todo", () => {
    const onOpen = renderCard();
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(deleteTodo).toHaveBeenCalledWith("t1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clamps the note to 4 lines", () => {
    renderCard();
    expect(screen.getByText("a clamped note").className).toContain("line-clamp-4");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bunx vitest run web-tests/TodoCard.test.tsx`
Expected: FAIL — `onOpen` is never called (no card click handler yet) and the note has no `line-clamp-4`.

- [ ] **Step 7: Rewrite `TodoCard.tsx`**

Replace `src/web/components/TodoCard.tsx` with:
```tsx
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
```

- [ ] **Step 8: Run the TodoCard test to verify it passes**

Run: `bunx vitest run web-tests/TodoCard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Wire the modal into `Board.tsx`**

Replace `src/web/components/Board.tsx` with:
```tsx
import { useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { State, Session, TodoStatus, Todo } from "../types.ts";
import { patchTodo } from "../api.ts";
import { resolveDrop } from "../drag.ts";
import { Lane, Column } from "./Lane.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";
import { TodoModal } from "./TodoModal.tsx";

const TODO_COLS: { id: TodoStatus; title: string; dot: string }[] = [
  { id: "todo", title: "To do", dot: "bg-attention" },
  { id: "done", title: "Done", dot: "bg-done" },
];

const SESSION_COLS: { id: Session["status"]; title: string; dot: string }[] = [
  { id: "working", title: "Working", dot: "bg-working" },
  { id: "needs_you", title: "Needs you", dot: "bg-attention" },
  { id: "idle", title: "Idle / done", dot: "bg-idle" },
];

export function Board({ state }: { state: State }) {
  const [selected, setSelected] = useState<Todo | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const byTodo = (s: TodoStatus) => state.todos.filter((t) => t.status === s);
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  function onDragEnd(e: DragEndEvent) {
    const drop = resolveDrop(state.todos, String(e.active.id), e.over ? String(e.over.id) : null);
    if (drop) patchTodo(drop.id, { status: drop.status });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <AppBar state={state} />

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <Lane label="★ Todos" hint="manual — drag cards as you deal with them">
          {TODO_COLS.map((c) => {
            const items = byTodo(c.id);
            return (
              <Column key={c.id} id={c.id} title={c.title} dot={c.dot} count={items.length} droppable>
                {items.map((t) => (
                  <TodoCard key={t.id} t={t} onOpen={setSelected} />
                ))}
              </Column>
            );
          })}
        </Lane>
      </DndContext>

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => {
          const items = bySession(c.id);
          return (
            <Column key={c.id} id={`sess-${c.id}`} title={c.title} dot={c.dot} count={items.length}>
              {items.map((s) => (
                <SessionCard key={s.id} s={s} />
              ))}
            </Column>
          );
        })}
      </Lane>

      <TodoModal todo={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
```

- [ ] **Step 10: Verify and commit**

Run: `bun run web:test` → expect all green (TodoModal + TodoCard + the unchanged Board/AppBar/useTheme/useTextSize/drag tests).
Run: `bun run typecheck` → clean.
Run: `bun run web:build` → succeeds.
```bash
git add src/web web-tests
git commit -m "feat(web): clamp todo cards + click-to-open detail modal"
```

---

## Task 3: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `bun run web:test` → all web tests green.
Run: `bun run typecheck` → clean (both tsconfigs).
Run: `bun run web:build` → build succeeds.

- [ ] **Step 2: Manual visual check**

Rebuild (`bun run web:build`), then open the dashboard served by the running server at `http://localhost:4317/` (the backend serves `dist/web` statically — no server restart needed for web changes). Confirm:
- The app bar shows an `A− / A+` stepper; clicking `A+` enlarges the whole UI, `A−` shrinks it; the choice **persists across reload with no flash**, and the buttons disable at the ends.
- A todo with a long note shows a **clamped** card (≈4 lines); **clicking** the card opens a modal with the full note + meta; **Esc**, the **✕**, and a **backdrop click** all close it.
- **Dragging** a card between **To do** and **Done** still works and does **not** open the modal.

---

## Self-Review Notes (already applied)

- **Spec coverage:** size control (Task 1: hook + stepper + no-flash + `2xs` token + label swaps), todo clamp + modal (Task 2: `line-clamp-2/4`, `PointerSensor` 5px threshold, native `<dialog>` modal, click-to-open with ✕ `stopPropagation`, `Board` wiring), tests for each new unit, manual verification (Task 3). Non-goals respected: todos-only, view-only modal, no server/deps changes.
- **Ordering:** Task 1 adds the `2xs` token before Task 2's `TodoCard` uses `text-2xs`. `onOpen` is **optional**, so the `TodoCard` rewrite (Step 7) and the `Board` wiring (Step 9) each compile independently — no broken intermediate.
- **No double-edit:** the `TodoCard` `text-[11px]`→`text-2xs` swap lives only in Task 2's full rewrite (Task 1 swaps `Lane` + `SessionCard` only).
- **Regression safety:** `Board.test.tsx` and `AppBar.test.tsx` are untouched and stay green — clamping/sensors don't change asserted text, and the new A−/A+ buttons carry distinct `aria-label`s that don't collide with `getByText`/`getByLabelText` queries. `showModal()`/`close()` are wrapped in `try/catch` for jsdom.
- **Type/name consistency:** `useTextSize` returns `{ size, inc, dec, canInc, canDec }` consumed in `AppBar`; `TodoCard`'s `onOpen?: (t: Todo) => void` matches `Board`'s `setSelected`; `TodoModal`'s `{ todo, onClose }` matches `Board`'s render.
