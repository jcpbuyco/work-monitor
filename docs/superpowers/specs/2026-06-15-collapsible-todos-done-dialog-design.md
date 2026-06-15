# Collapsible to-do list + Done behind a dialog

**Date:** 2026-06-15
**Status:** Implemented (2026-06-15) — built subagent-driven on branch `feat/collapsible-todos-done-dialog`. Plan: `docs/superpowers/plans/2026-06-15-collapsible-todos-done-dialog.md`. Web-only (rebuild `dist/web`, reload the tab — no server restart). 35 web tests + typecheck + build green.
**Scope:** `src/web/` only (plus removing the `@dnd-kit` dependency from `package.json`). No server, DB, API, or hook changes — `/api/state` already returns all todos with timestamps.

## Motivation

The todos lane is a two-column kanban (To do / Done). Done todos accumulate with no bound, so the lane grows tall, pushes the sessions lane off-screen, and the board stops fitting on one page. Goal: keep the board to one page by showing only the open to-do list (itself collapsible) and moving completed todos behind a paginated dialog.

## Decisions (settled during brainstorming)

- Collapse the two-column todos lane to a **single To-do list** (open todos only).
- The to-do list is itself **collapsible** (header toggle, persisted) so it can be put out of the way when it gets long.
- Completed todos move off the board, reachable via a **`✓ Done (M) →` link** that opens a **paginated, latest-first dialog**.
- Drag-to-Done is replaced by a **✓ "mark done"** button on each card; the `@dnd-kit` drag machinery is **removed** entirely (it was only used for todo drag).
- **Web-only** — done todos are already in client state, so the dialog sorts/paginates client-side.

## 1. Layout + collapse (`TodosSection`)

A new `src/web/components/TodosSection.tsx` owns the whole todos UI (replacing the todos `<Lane>` in `Board`). `Board` becomes: `<AppBar/>` + `<TodosSection todos={state.todos}/>` + the sessions `<Lane>`.

- **Header (always visible):** `★ Todos (N) ▾` where N = count of `status === "todo"`. The header row is a button that toggles collapse; the chevron is `▾` (expanded) / `▸` (collapsed).
- **Collapse state** comes from a new hook `src/web/usePersistedToggle.ts`: `usePersistedToggle(key, initial=false): [boolean, () => void]` — reads `localStorage[key]` in the `useState` initializer (so the first render already reflects the saved state — no flicker), persists on toggle. Used as `usePersistedToggle("wm-todos-collapsed")`.
- **Expanded body:** the open todos rendered as `TodoCard`s, followed by the `✓ Done (M) →` link (bottom of the list). **Collapsed:** body hidden — just the header line (board stays compact regardless of count).
- The old "manual — drag cards…" hint is dropped (drag is gone); a short hint like "✓ to complete · ✕ to delete" may sit by the header.

## 2. Mark done (✓ button on `TodoCard`)

`TodoCard` gets a **✓** button beside the ✕ (`aria-label="Mark done"`), with `onPointerDown`/`onClick` `stopPropagation` (so it neither opens the detail modal nor — formerly — started a drag). Click calls `patchTodo(t.id, { status: "done" })` (same `api.ts` function drag used). On the SSE state refresh the card leaves the to-do list and appears in the Done dialog. Card click still opens the detail `TodoModal`; ✕ still deletes.

## 3. Done dialog (`DoneDialog`)

New `src/web/components/DoneDialog.tsx`, native `<dialog>` (same open/close pattern as `TodoModal`: `showModal`/`close` in an effect, wrapped in try/catch; closes via ✕ / Esc / backdrop click).

- Props: `{ open: boolean; done: Todo[]; onClose: () => void }`. `TodosSection` passes `done = todos.filter(t => t.status === "done")` and an `open` boolean it controls from the link.
- **Sort latest-first** by `updated_at` descending (most recently completed on top).
- **Paginate client-side:** `PAGE_SIZE = 10`; internal `page` state (reset to 0 each time it opens); **Prev/Next** buttons (disabled at ends) + an `X–Y of M` indicator.
- **Rows** (compact): title (`line-clamp-1`), then meta — `→ for_who`, `⎇ branch`, `origin_project` — and `done {ago(updated_at)}` (relative time). Read-only (no nested modal/edit in v1).
- Empty state: "No completed todos yet."

## 4. Remove drag-and-drop

The single-column list has nothing to drag between, so remove the drag machinery (the ✓ button replaces drag-to-Done):
- `TodoCard.tsx`: drop `useDraggable`, `listeners`, `attributes`, the `transform`/`isDragging` style, and `cursor-grab`. The card is a plain clickable `<div onClick={() => onOpen?.(t)}>`.
- `Lane.tsx` `Column`: drop `useDroppable`, `isOver`, the `droppable` prop, and the `ring-2 ring-primary` highlight — `Column` becomes purely presentational (still used by the sessions lane).
- `Board.tsx`: remove `DndContext`, `useSensor`/`useSensors`/`PointerSensor`, `onDragEnd`, and the `resolveDrop` import.
- Delete `src/web/drag.ts` and `web-tests/drag.test.ts`.
- Remove `@dnd-kit/core` (and `@dnd-kit/sortable` if unused — grep to confirm) from `package.json` `devDependencies`, and run `bun install` so the lockfile updates.

## 5. Data (web-only)

- Add `updated_at: number` to the web `Todo` type (`src/web/types.ts`) — the server already includes it in `/api/state`; the web type just declares it for sorting + relative time. (Other Todo-constructing test fixtures gain `updated_at`.)
- Extract the relative-time helper `ago(ts)` from `SessionCard.tsx` into a shared `src/web/time.ts` (used by `SessionCard` + `DoneDialog`) to avoid duplication.
- No `patchTodo`/`deleteTodo`/`/api/*` changes.

## 6. Files

- **New:** `src/web/components/TodosSection.tsx`, `src/web/components/DoneDialog.tsx`, `src/web/usePersistedToggle.ts`, `src/web/time.ts`.
- **Modify:** `src/web/components/Board.tsx` (use `TodosSection`, drop dnd), `src/web/components/TodoCard.tsx` (drop dnd, add ✓), `src/web/components/Lane.tsx` (drop dnd from `Column`), `src/web/components/SessionCard.tsx` (import `ago` from `time.ts`), `src/web/types.ts` (`Todo.updated_at`), `package.json` (drop `@dnd-kit`).
- **Delete:** `src/web/drag.ts`, `web-tests/drag.test.ts`.
- **Tests:** new `web-tests/usePersistedToggle.test.ts`, `web-tests/DoneDialog.test.tsx`, `web-tests/TodosSection.test.tsx`; update `web-tests/{TodoCard,Board,AppBar}.test.tsx` (remove drag assumptions, add the ✓ button test, add `updated_at` to fixtures).

## 7. Testing

- **`usePersistedToggle`**: default value; reads a stored value; toggle flips + persists to `localStorage`.
- **`TodoCard`**: clicking ✓ calls `patchTodo(id, { status: "done" })` and does **not** open the detail modal; clicking the card opens it; ✕ deletes; card is no longer draggable (no `cursor-grab`, no dnd attributes).
- **`DoneDialog`**: renders done todos **latest-first** (a fixture with out-of-order `updated_at` comes back sorted); paginates (with `> PAGE_SIZE` items, page 2 shows the rest; Prev/Next bounds); empty state when none; ✕ closes.
- **`TodosSection`**: shows the open todos + the `Done (M)` count; collapsing hides the list; the Done link opens the dialog; no Done column rendered.
- **`Board`**: renders `TodosSection` + the sessions lane; no `DndContext`; existing session text assertions still pass.
- Full `bun run web:test` + `typecheck` + `web:build` green.

## 8. Non-goals

- No backend/DB/API/SSE changes; no restart needed (web-only — rebuild `dist/web`, reload the tab). No editing or deleting done todos *from the dialog* (read-only log) — deletion stays a follow-up if wanted. No server-side pagination (client-side is fine at expected volumes). No collapse for the sessions lane.
