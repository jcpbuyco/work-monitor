# Generalize hand-offs into a simple todo tool

**Date:** 2026-06-15
**Status:** Approved design — ready for implementation plan
**Scope:** MCP tool surface + the todo status model (server + dashboard + DB migration). Sessions, hooks, and the REST ingestion path are untouched except for the todo status enum.

## Motivation

The MCP tool `record_handoff` is scoped too narrowly. The description an agent sees tells it to use the tool only "when the user asks you to remember to hand work off to another engineer," and the name + the `for_who` field reinforce that. So an agent will deliberately *not* use it for a general todo or a reminder-to-self. But the thing it creates is, underneath, just a `Todo` (the store already uses `createTodo`/`listTodos`/`updateTodo`). We want any agent to reach for this tool to track **any** task, reminder, or hand-off — and the dashboard to read as a plain todo list rather than a hand-off workflow.

## Decisions (settled during brainstorming)

1. **Full generalization** (not just a description tweak): rename the tools, broaden the descriptions, and replace the hand-off-specific statuses.
2. **Statuses become a 2-state list: `todo` / `done`** (down from `to_hand_off` / `handed_off` / `done`). The dashboard's todo lane goes from 3 columns to 2.
3. **Tool renames:** `record_handoff` → `add_todo`, `update_handoff` → `update_todo`; `list_todos` keeps its name. Clean rename, **no backward-compat alias** (agents re-discover tools each session; nothing else calls them).
4. **`note` becomes optional** to lower friction for quick todos. `title` stays required.
5. The hand-off-flavored optional fields (`for_who`, `project`, `branch`, `links`) are **kept** (still useful when a todo *is* a hand-off), just re-described generically.

## 1. MCP tool surface (`src/server/mcp.ts`)

Rename the tool implementations and `registerTool` names, and replace the descriptions. Use these exact descriptions:

- **`add_todo`** — "Record a todo on the work-monitor dashboard — any task, reminder, or hand-off worth not forgetting, for yourself or someone else (not limited to engineer hand-offs). Use whenever you or the user want something tracked on the board. Put any useful context in `note`."
  - `title` (required): "Short title, e.g. 'Run bun run setup' or 'Hand off payments spec'"
  - `note` (**optional**): "Optional context — what's done, what's left, paths"
  - `for_who` (optional): "Optional — who it's for, if you're handing off to someone"
  - `project` (optional): "Optional project name"
  - `branch` (optional): "Optional git branch the work is on"
  - `links` (optional): "Optional — spec paths, PR URLs, etc."
- **`list_todos`** — "List todos on the work-monitor dashboard (optionally filtered by status) — e.g. to avoid creating duplicates or to check what's still open." `status` enum → `["todo","done"]`.
- **`update_todo`** — "Update a todo on the work-monitor dashboard — mark it done (or back to todo), or amend its note."
  - `id` (required), `status` (optional) enum `["todo","done"]`, `note` (optional).

The `makeTools()` object keys rename to `add_todo` / `update_todo` (keep `list_todos`). The thin `registerTool` handlers call the renamed impls.

## 2. Status model + migration

- **`TodoStatus` = `"todo" | "done"`** in both `src/server/types.ts` and `src/web/types.ts`.
- **`src/server/db.ts`:**
  - Change the `todos.status` column default from `'to_hand_off'` to `'todo'` (affects fresh DBs).
  - Add an idempotent data migration inside `migrate()` after the `CREATE TABLE` block:
    ```sql
    UPDATE todos SET status = 'todo' WHERE status IN ('to_hand_off', 'handed_off');
    ```
    (`done` rows are already correct.) Safe to run on every startup. The live DB currently holds 0 todos, so this is effectively a no-op now, but it correctly migrates any legacy rows in other DBs. Note: `CREATE TABLE IF NOT EXISTS` is a no-op on an existing DB, so the *column default* stays old there — harmless, because `createTodo` always writes the status explicitly (below).
- **`src/server/store.ts`:** `createTodo` inserts `'todo'` (was `'to_hand_off'`); the `MAX(position)` query keys on `status = 'todo'`.
- **`src/server/http.ts`:** `TODO_STATUSES` → `new Set(["todo", "done"])`.

## 3. Dashboard (top lane)

- **`src/web/components/Board.tsx`:**
  - Lane heading `★ Hand-offs & todos` → **`★ Todos`** (hint text unchanged).
  - `TODO_COLS` becomes 2 entries: `{ id: "todo", title: "To do", dot: "bg-attention" }`, `{ id: "done", title: "Done", dot: "bg-done" }`. The `handed_off`/indigo column is removed.
- **`src/web/drag.ts`:** `STATUSES` → `["todo", "done"]`. Dropping a card on the other column still calls `resolveDrop` → `patchTodo(id, { status })`; dropping on its own column or a session column still returns `null`.
- **`src/web/components/AppBar.tsx`:** the third count chip `… to hand off` → **`… to do`**, counting `status === "todo"`. The brand/working/needs-you chips and the sessions lane are unchanged.
- Colors carried over: `todo` = amber (`bg-attention`), `done` = emerald (`bg-done`). (Adjustable, not load-bearing.)

## 4. Files touched

- **Server:** `src/server/mcp.ts`, `src/server/types.ts`, `src/server/db.ts`, `src/server/store.ts`, `src/server/http.ts`
- **Web:** `src/web/types.ts`, `src/web/drag.ts`, `src/web/components/Board.tsx`, `src/web/components/AppBar.tsx`
- **Tests:** `tests/mcp.test.ts`, `tests/mcp-http.test.ts`, `tests/store.test.ts`, `tests/http.test.ts`, `web-tests/Board.test.tsx`, `web-tests/AppBar.test.tsx`, `web-tests/drag.test.ts`
- **Docs:** `README.md` (tool names, "hand-off" framing, the `To hand off → Handed off → Done` column description → `To do → Done`).
- Historical artifacts under `docs/superpowers/specs|plans/2026-06-14-*` are left as-is (records of past work).

## 5. Testing

- **MCP** (`tests/mcp.test.ts`, `tests/mcp-http.test.ts`): `add_todo` creates a `todo`-status row (with origin/branch); `add_todo` with no `note` succeeds (note now optional); `update_todo({status:"done"})` flips status; `update_todo` on a missing id → `ok:false`; the registry lists exactly `["add_todo","list_todos","update_todo"]`; an HTTP tool call to `add_todo` creates a todo.
- **Migration** (extend `tests/store.test.ts` or a small `tests/db.test.ts`): open a DB, insert a row with legacy `status='handed_off'` (and one `'to_hand_off'`), re-run `migrate`, assert both become `'todo'` and a `'done'` row stays `'done'`.
- **Store/HTTP** (`tests/store.test.ts`, `tests/http.test.ts`): `createTodo` / POST `/api/todos` produce `status='todo'`; `listTodos("todo")` filter works.
- **Web** (`web-tests/*`): Board renders a `todo` card in the "To do" column (text assertions `"Hand off spec"`, `"→ Maria"` still hold); `drag.test` covers `todo ↔ done` and rejects non-columns; AppBar shows the "to do" count.
- Full suites green: `bun run test` (server) + `bun run web:test` + `bun run typecheck` + `bun run web:build`.

## 6. Non-goals

- No alias for the old tool names; no change to sessions, hooks, SSE, or the REST event-ingestion shape (only the todo status enum changes).
- No new dependencies. No change to the `Todo` fields (`for_who`/`branch`/etc. remain).
- **Activation:** picking up the renamed tools + the migration requires a **server restart** (and reconnecting agent sessions). That restart is the user's to run, consistent with the existing setup caution.
