# Dashboard UI Redesign (shadcn-inspired) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented — merged to `main` (2026-06-14)

**Goal:** Give the work-monitor dashboard a polished, shadcn-style look with a light/dark theme toggle, without changing the two-lane × three-column information architecture or any backend.

**Architecture:** Introduce a hand-rolled shadcn token layer — HSL CSS variables in `styles.css` (light under `:root`, dark under `html.dark`) mapped to semantic Tailwind color names via `tailwind.config.js`. A `useTheme` hook plus a no-flash inline script drive `darkMode: 'class'`. A new sticky `AppBar` (brand + live counts + theme toggle) replaces the bare `<h1>`. The four card/lane components are restyled to token classes while preserving their exact text content so existing tests stay green.

**Tech Stack:** React 18 + TypeScript, Tailwind CSS v3, Vite, Vitest + @testing-library/react (jsdom). No new dependencies.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tailwind.config.js` | Modify | `darkMode: 'class'`, map tokens → semantic colors, custom card shadows |
| `src/web/styles.css` | Rewrite | Token layer (light/dark CSS variables), base body styles |
| `src/web/useTheme.ts` | Create | Resolve + toggle + persist theme; apply `dark` class |
| `web-tests/useTheme.test.ts` | Create | Unit test for the hook |
| `src/web/index.html` | Modify | No-flash inline theme script |
| `src/web/components/AppBar.tsx` | Create | Sticky header: brand, live counts, theme toggle |
| `web-tests/AppBar.test.tsx` | Create | Counts derivation + toggle wiring |
| `src/web/components/Board.tsx` | Modify | Render `AppBar`, pass `dot` to columns, token container |
| `src/web/components/Lane.tsx` | Modify | Token-styled `Lane`/`Column`, status dots, responsive grid, violet drop ring |
| `src/web/components/SessionCard.tsx` | Modify | Token restyle, status dot+label, amber attention callout |
| `src/web/components/TodoCard.tsx` | Modify | Token restyle, hover-reveal delete |

**Key invariant for tests:** `web-tests/Board.test.tsx` asserts these exact strings render: `"browns"`, `"Refactor (1/3 done)"`, `"⚠ Run migration?"`, `"Hand off spec"`, `"→ Maria"`. Every restyle MUST keep each of these as the full text of a single element (no splitting the text across child elements). `web-tests/drag.test.ts` only tests `resolveDrop` and is unaffected as long as droppable ids (`to_hand_off`/`handed_off`/`done` and `sess-*`) are unchanged.

---

## Task 1: Token layer (Tailwind config + styles.css)

**Files:**
- Modify: `tailwind.config.js`
- Rewrite: `src/web/styles.css`

- [ ] **Step 1: Rewrite `tailwind.config.js`**

```js
export default {
  darkMode: "class",
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        chip: "hsl(var(--chip) / <alpha-value>)",
        primary: "hsl(var(--primary) / <alpha-value>)",
        working: "hsl(var(--working) / <alpha-value>)",
        attention: "hsl(var(--attention) / <alpha-value>)",
        handed: "hsl(var(--handed) / <alpha-value>)",
        done: "hsl(var(--done) / <alpha-value>)",
        idle: "hsl(var(--idle) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          hover: "hsl(var(--card-hover) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
      },
      boxShadow: {
        card: "0 1px 2px hsl(var(--shadow) / var(--shadow-a))",
        "card-hover": "0 4px 14px hsl(var(--shadow) / var(--shadow-a))",
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 2: Rewrite `src/web/styles.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: light;
  --background: 210 30% 98%;
  --card: 0 0% 100%;
  --card-hover: 214 32% 97%;
  --muted: 214 24% 94%;
  --muted-foreground: 220 12% 42%;
  --foreground: 222 34% 12%;
  --border: 214 22% 86%;
  --chip: 214 24% 92%;
  --shadow: 220 40% 30%;
  --shadow-a: 0.08;
  --primary: 258 82% 56%;
  --working: 213 88% 50%;
  --attention: 35 92% 46%;
  --handed: 245 70% 58%;
  --done: 152 55% 38%;
  --idle: 220 10% 55%;
}

html.dark {
  color-scheme: dark;
  --background: 222 26% 5%;
  --card: 222 20% 8.5%;
  --card-hover: 222 18% 11%;
  --muted: 222 16% 15%;
  --muted-foreground: 220 12% 60%;
  --foreground: 210 22% 95%;
  --border: 222 16% 16%;
  --chip: 222 16% 16%;
  --shadow: 0 0% 0%;
  --shadow-a: 0.35;
  --primary: 258 90% 67%;
  --working: 213 90% 62%;
  --attention: 38 94% 58%;
  --handed: 246 84% 70%;
  --done: 152 58% 48%;
  --idle: 220 10% 55%;
}

body {
  @apply bg-background text-foreground antialiased;
}
```

- [ ] **Step 3: Verify the build compiles**

Run: `bun run web:build`
Expected: build succeeds (Vite writes `dist/web`), no Tailwind/PostCSS errors.

- [ ] **Step 4: Verify existing tests still pass**

Run: `bun run web:test`
Expected: PASS (Board + drag tests still green — components still use their old classes, which remain valid).

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.js src/web/styles.css
git commit -m "feat(web): shadcn token layer (css variables + tailwind mapping)"
```

---

## Task 2: `useTheme` hook (TDD)

**Files:**
- Create: `src/web/useTheme.ts`
- Test: `web-tests/useTheme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-tests/useTheme.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "../src/web/useTheme.ts";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("resolves stored 'light' and leaves the dark class off", () => {
    localStorage.setItem("wm-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("resolves stored 'dark' and adds the dark class", () => {
    localStorage.setItem("wm-theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("falls back to system preference when nothing is stored", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, media: q, addEventListener() {}, removeEventListener() {},
    }));
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light"); // prefers-color-scheme: light matches
  });

  it("toggle flips theme, the dark class, and persists to localStorage", () => {
    localStorage.setItem("wm-theme", "light");
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("wm-theme")).toBe("dark");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run web-tests/useTheme.test.ts`
Expected: FAIL — cannot resolve `../src/web/useTheme.ts` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/web/useTheme.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem("wm-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
  } catch {}
  return "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(resolveTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("wm-theme", next);
      } catch {}
      return next;
    });
  }, []);

  return { theme, toggle };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run web-tests/useTheme.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 6: Commit**

```bash
git add src/web/useTheme.ts web-tests/useTheme.test.ts
git commit -m "feat(web): useTheme hook with localStorage + system-preference resolution (TDD)"
```

---

## Task 3: No-flash inline theme script

**Files:**
- Modify: `src/web/index.html`

- [ ] **Step 1: Add the inline script to `<head>`**

Replace the `<head>` block in `src/web/index.html` with (script added after `<title>`):

```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>work-monitor</title>
    <script>
      (function () {
        try {
          var t = localStorage.getItem('wm-theme');
          if (t !== 'light' && t !== 'dark') {
            t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
              ? 'light'
              : 'dark';
          }
          if (t === 'dark') document.documentElement.classList.add('dark');
        } catch (e) {}
      })();
    </script>
  </head>
```

(This mirrors `resolveTheme` exactly so the class is applied before first paint — no flash — and the hook reads the same result on mount.)

- [ ] **Step 2: Verify the build still compiles**

Run: `bun run web:build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/web/index.html
git commit -m "feat(web): no-flash inline theme script"
```

---

## Task 4: `AppBar` component (TDD)

**Files:**
- Create: `src/web/components/AppBar.tsx`
- Test: `web-tests/AppBar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web-tests/AppBar.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppBar } from "../src/web/components/AppBar.tsx";
import type { State } from "../src/web/types.ts";

const state: State = {
  sessions: [
    { id: "s1", project: "a", status: "working", current_task: null, current_intent: null, attention_reason: null, started_at: 0, last_activity_at: 0 },
    { id: "s2", project: "b", status: "needs_you", current_task: null, current_intent: null, attention_reason: "x", started_at: 0, last_activity_at: 0 },
  ],
  todos: [
    { id: "t1", title: "t", note: "", for_who: null, status: "to_hand_off", origin_project: null, branch: null, links: null, position: 0 },
  ],
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("AppBar", () => {
  it("shows live counts derived from state", () => {
    render(<AppBar state={state} />);
    expect(screen.getByText("1 working")).toBeDefined();
    expect(screen.getByText("1 needs you")).toBeDefined();
    expect(screen.getByText("1 to hand off")).toBeDefined();
  });

  it("toggles the dark class when the theme button is clicked", () => {
    localStorage.setItem("wm-theme", "light");
    render(<AppBar state={state} />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.click(screen.getByLabelText("Toggle theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run web-tests/AppBar.test.tsx`
Expected: FAIL — cannot resolve `../src/web/components/AppBar.tsx`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/AppBar.tsx`:

```tsx
import type { State } from "../types.ts";
import { useTheme } from "../useTheme.ts";

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
  const working = state.sessions.filter((s) => s.status === "working").length;
  const needsYou = state.sessions.filter((s) => s.status === "needs_you").length;
  const toHandOff = state.todos.filter((t) => t.status === "to_hand_off").length;

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
        <Count dotClass="bg-primary" label="to hand off" n={toHandOff} />
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-label="Toggle theme"
        className="ml-auto inline-flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <span>{theme === "dark" ? "☾" : "☀"}</span>
        <span>{theme === "dark" ? "Dark" : "Light"}</span>
      </button>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run web-tests/AppBar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/AppBar.tsx web-tests/AppBar.test.tsx
git commit -m "feat(web): sticky AppBar with live counts and theme toggle (TDD)"
```

---

## Task 5: Restyle `Board` + `Lane`/`Column`

**Files:**
- Modify: `src/web/components/Board.tsx`
- Modify: `src/web/components/Lane.tsx`

- [ ] **Step 1: Rewrite `src/web/components/Lane.tsx`**

```tsx
import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";

export function Column({
  id,
  title,
  count,
  dot,
  droppable,
  children,
}: {
  id: string;
  title: string;
  count: number;
  dot: string;
  droppable?: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={`rounded-xl border border-border bg-card/50 p-2.5 transition ${isOver ? "ring-2 ring-primary" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between px-1 py-0.5">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {title}
        </span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="rounded-full border border-border bg-chip px-2 py-0.5 text-[11px] text-muted-foreground">{hint}</span>
      </div>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Rewrite `src/web/components/Board.tsx`**

```tsx
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import type { State, Session, TodoStatus } from "../types.ts";
import { patchTodo } from "../api.ts";
import { resolveDrop } from "../drag.ts";
import { Lane, Column } from "./Lane.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { SessionCard } from "./SessionCard.tsx";
import { AppBar } from "./AppBar.tsx";

const TODO_COLS: { id: TodoStatus; title: string; dot: string }[] = [
  { id: "to_hand_off", title: "To hand off", dot: "bg-attention" },
  { id: "handed_off", title: "Handed off", dot: "bg-handed" },
  { id: "done", title: "Done", dot: "bg-done" },
];

const SESSION_COLS: { id: Session["status"]; title: string; dot: string }[] = [
  { id: "working", title: "Working", dot: "bg-working" },
  { id: "needs_you", title: "Needs you", dot: "bg-attention" },
  { id: "idle", title: "Idle / done", dot: "bg-idle" },
];

export function Board({ state }: { state: State }) {
  const byTodo = (s: TodoStatus) => state.todos.filter((t) => t.status === s);
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  function onDragEnd(e: DragEndEvent) {
    const drop = resolveDrop(state.todos, String(e.active.id), e.over ? String(e.over.id) : null);
    if (drop) patchTodo(drop.id, { status: drop.status });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12">
      <AppBar state={state} />

      <DndContext onDragEnd={onDragEnd}>
        <Lane label="★ Hand-offs & todos" hint="manual — drag cards as you deal with them">
          {TODO_COLS.map((c) => (
            <Column key={c.id} id={c.id} title={c.title} dot={c.dot} count={byTodo(c.id).length} droppable>
              {byTodo(c.id).map((t) => (
                <TodoCard key={t.id} t={t} />
              ))}
            </Column>
          ))}
        </Lane>
      </DndContext>

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => (
          <Column key={c.id} id={`sess-${c.id}`} title={c.title} dot={c.dot} count={bySession(c.id).length}>
            {bySession(c.id).map((s) => (
              <SessionCard key={s.id} s={s} />
            ))}
          </Column>
        ))}
      </Lane>
    </div>
  );
}
```

- [ ] **Step 3: Run the full web test suite**

Run: `bun run web:test`
Expected: PASS — `Board.test.tsx` (text assertions unchanged), `drag.test.ts`, `useTheme.test.ts`, `AppBar.test.tsx` all green.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/Board.tsx src/web/components/Lane.tsx
git commit -m "feat(web): app bar + token-styled lanes/columns with violet drop ring"
```

---

## Task 6: Restyle `SessionCard`

**Files:**
- Modify: `src/web/components/SessionCard.tsx`

- [ ] **Step 1: Rewrite `src/web/components/SessionCard.tsx`**

```tsx
import type { Session } from "../types.ts";

const STATUS: Record<string, { accent: string; label: string; dot: string }> = {
  working: { accent: "var(--working)", label: "Working", dot: "bg-working" },
  needs_you: { accent: "var(--attention)", label: "Needs you", dot: "bg-attention" },
  idle: { accent: "var(--idle)", label: "Idle", dot: "bg-idle" },
  ended: { accent: "var(--idle)", label: "Ended", dot: "bg-idle" },
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function SessionCard({ s }: { s: Session }) {
  const st = STATUS[s.status] ?? STATUS.idle;
  return (
    <div
      className="mb-2 rounded-lg border border-border bg-card p-3 shadow-card transition hover:bg-card-hover hover:shadow-card-hover"
      style={{ borderLeft: `3px solid hsl(${st.accent})` }}
    >
      <div className="font-medium text-foreground">{s.project}</div>
      <div
        className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] font-semibold"
        style={{ color: `hsl(${st.accent})` }}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
        {st.label}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">
        {s.current_task ?? s.current_intent ?? "—"}
      </div>
      {s.attention_reason && s.status === "needs_you" && (
        <div className="mt-2 rounded-md border border-attention/25 bg-attention/10 px-2 py-1.5 text-xs text-attention">
          ⚠ {s.attention_reason}
        </div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground/70">{ago(s.last_activity_at)}</div>
    </div>
  );
}
```

Note: `{s.project}`, `{s.current_task ?? ...}`, and `⚠ {s.attention_reason}` each remain the sole text of their element, so `Board.test.tsx`'s `getByText("browns")`, `getByText("Refactor (1/3 done)")`, and `getByText("⚠ Run migration?")` still match.

- [ ] **Step 2: Run the full web test suite**

Run: `bun run web:test`
Expected: PASS (Board text assertions for `browns`, `Refactor (1/3 done)`, `⚠ Run migration?` still pass).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/SessionCard.tsx
git commit -m "feat(web): restyle SessionCard with status dot+label and attention callout"
```

---

## Task 7: Restyle `TodoCard`

**Files:**
- Modify: `src/web/components/TodoCard.tsx`

- [ ] **Step 1: Rewrite `src/web/components/TodoCard.tsx`**

```tsx
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
          className="text-xs text-muted-foreground/50 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
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
```

Note: `{t.title}` and `→ {t.for_who}` each remain the sole text of their element, so `Board.test.tsx`'s `getByText("Hand off spec")` and `getByText("→ Maria")` still match.

- [ ] **Step 2: Run the full web test suite**

Run: `bun run web:test`
Expected: PASS (Board text assertions for `Hand off spec`, `→ Maria` still pass).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/TodoCard.tsx
git commit -m "feat(web): restyle TodoCard with hover-reveal delete and token styling"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `bun run web:test`
Expected: PASS — `Board.test.tsx`, `drag.test.ts`, `useTheme.test.ts`, `AppBar.test.tsx` all green.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (both `tsconfig.json` and `tsconfig.web.json`).

- [ ] **Step 3: Production build**

Run: `bun run web:build`
Expected: build succeeds, no errors.

- [ ] **Step 4: Manual visual check**

Run: `bun run web:dev` and open the printed URL (default `http://localhost:5317`). With the server (`bun run server`) running for live data, or just to view layout:
- Confirm the dark theme renders with slate surfaces + violet brand accent.
- Click the theme toggle → switches to light; reload → choice persists with no flash.
- Narrow the window to phone width → columns stack to a single column, app bar wraps cleanly.
- Confirm status dots/colors: working=blue, needs-you/to-hand-off=amber, handed-off=indigo, done=emerald, idle=muted; the "needs you" attention callout shows amber.
- Drag a hand-off card between columns → violet drop-target ring appears and the move persists.

- [ ] **Step 5: Commit (if any incidental fixes were made)**

```bash
git add -A
git commit -m "chore(web): final verification fixes for dashboard redesign"
```

(If nothing changed in this task, skip the commit.)

---

## Self-Review Notes (already applied)

- **Spec coverage:** token layer (Task 1), light+dark toggle (Tasks 2–3), app bar + light structure (Task 4–5), restyle of all four components (Tasks 5–7), responsive + manual verification (Task 8), testing plan (`useTheme` + `AppBar` tests added; `Board.test.tsx` kept green by preserving exact text nodes). Non-goals respected: no new deps, no IA change, no backend/drag-reorder work.
- **Type consistency:** `Column` uses `dot: string` in both `Board.tsx` and `Lane.tsx`; `useTheme` returns `{ theme, toggle }` consumed identically in `AppBar.tsx`; status keys (`working`/`needs_you`/`idle`/`ended`) match `SessionStatus` in `types.ts`.
- **Tailwind JIT:** every dynamic dot class is passed as a full literal (`bg-working`, `bg-attention`, `bg-handed`, `bg-done`, `bg-idle`, `bg-primary`) that appears verbatim in `Board.tsx`/`AppBar.tsx`, so the JIT compiler includes them. Glow rings use inline `style` to avoid arbitrary-value fragility.
