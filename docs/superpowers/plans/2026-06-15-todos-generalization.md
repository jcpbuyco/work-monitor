# Generalize hand-offs into a simple todo tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the hand-off MCP tools to generic todo tools (`add_todo` / `list_todos` / `update_todo`), broaden their descriptions, make `note` optional, and collapse the todo statuses from `to_hand_off / handed_off / done` to `todo / done` (2-column board), with a migration for legacy rows.

**Architecture:** The server and the web app each define their own `TodoStatus`, so the change splits cleanly: Task 1 migrates the **server** (types, DB + migration, store, http, MCP tools) and its tests; Task 2 migrates the **web** app (types, drag, board, app bar) and its tests; Task 3 updates docs and runs full verification. After each task the whole project is green (the other half is untouched and internally consistent).

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `@modelcontextprotocol/sdk`, Zod, React + Vite + Tailwind, Bun test (server) + Vitest (web).

---

## Spec reference

`docs/superpowers/specs/2026-06-15-todos-generalization-design.md`

## Status mapping (used throughout)

| Legacy | New |
|---|---|
| `to_hand_off` | `todo` |
| `handed_off` | `todo` |
| `done` | `done` |

---

## Task 1: Server — statuses + tool rename + migration

**Files:**
- Modify: `src/server/types.ts`, `src/server/db.ts`, `src/server/store.ts`, `src/server/http.ts`, `src/server/mcp.ts`
- Modify (tests): `tests/store.test.ts`, `tests/http.test.ts`, `tests/mcp.test.ts`, `tests/mcp-http.test.ts`

- [ ] **Step 1: Narrow the server `TodoStatus`**

In `src/server/types.ts`, change line 51 from:
```ts
export type TodoStatus = "to_hand_off" | "handed_off" | "done";
```
to:
```ts
export type TodoStatus = "todo" | "done";
```

- [ ] **Step 2: Update DB default + add migration, and export `migrate`**

Replace the whole `src/server/db.ts` with:
```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL DEFAULT 'unknown',
      cwd TEXT NOT NULL DEFAULT '',
      transcript_path TEXT,
      status TEXT NOT NULL DEFAULT 'working',
      current_task TEXT,
      current_intent TEXT,
      attention_reason TEXT,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      for_who TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      origin_session_id TEXT,
      origin_project TEXT,
      branch TEXT,
      links TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // Idempotent: remap legacy hand-off statuses to the generic todo lifecycle.
  db.exec(`UPDATE todos SET status = 'todo' WHERE status IN ('to_hand_off', 'handed_off');`);
}
```
(`migrate` is now exported and gains the remap `UPDATE`; the `todos.status` default is `'todo'`.)

- [ ] **Step 3: Update `store.ts` createTodo**

In `src/server/store.ts`, `createTodo` (around lines 95–117): change the position-query status and the inserted status literal from `'to_hand_off'` to `'todo'`.

Replace:
```ts
    const nextPos =
      (this.db.query(`SELECT COALESCE(MAX(position), -1) AS m FROM todos WHERE status = 'to_hand_off'`).get() as { m: number }).m + 1;
    this.db
      .query(
        `INSERT INTO todos (${TODO_COLS}) VALUES ($id, $title, $note, $for_who, 'to_hand_off', $origin_session_id, $origin_project, $branch, $links, $position, $created_at, $updated_at)`
      )
```
with:
```ts
    const nextPos =
      (this.db.query(`SELECT COALESCE(MAX(position), -1) AS m FROM todos WHERE status = 'todo'`).get() as { m: number }).m + 1;
    this.db
      .query(
        `INSERT INTO todos (${TODO_COLS}) VALUES ($id, $title, $note, $for_who, 'todo', $origin_session_id, $origin_project, $branch, $links, $position, $created_at, $updated_at)`
      )
```

- [ ] **Step 4: Update `http.ts` status allow-list**

In `src/server/http.ts` line 24, change:
```ts
const TODO_STATUSES = new Set(["to_hand_off", "handed_off", "done"]);
```
to:
```ts
const TODO_STATUSES = new Set(["todo", "done"]);
```

- [ ] **Step 5: Rename + rewrite the MCP tools**

In `src/server/mcp.ts`, replace the contiguous block from `export function makeTools(deps: McpDeps) {` through the closing `}` of `buildServer` (i.e. everything up to — but not including — the `const transports: Record<...>` line). The imports/`McpDeps` above and the `const transports` / `handleMcpRequest` below stay exactly as they are. New block:
```ts
export function makeTools(deps: McpDeps) {
  const now = deps.now ?? (() => Date.now());
  const { store, onChange } = deps;
  return {
    add_todo(input: {
      title: string;
      note?: string;
      for_who?: string;
      project?: string;
      branch?: string;
      links?: string[];
    }) {
      const todo = store.createTodo(
        {
          title: input.title,
          note: input.note ?? "",
          for_who: input.for_who ?? null,
          origin_project: input.project ?? null,
          branch: input.branch ?? null,
          links: input.links ?? null,
        },
        now()
      );
      onChange();
      return { id: todo.id, status: todo.status };
    },
    list_todos(input: { status?: TodoStatus }) {
      return { todos: store.listTodos(input.status) };
    },
    update_todo(input: { id: string; status?: TodoStatus; note?: string }) {
      const patch: { status?: TodoStatus; note?: string } = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.note !== undefined) patch.note = input.note;
      const updated = store.updateTodo(input.id, patch, now());
      if (updated) onChange();
      return { ok: !!updated };
    },
  };
}

function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "work-monitor", version: "0.1.0" });
  const tools = makeTools(deps);

  server.registerTool(
    "add_todo",
    {
      description:
        "Record a todo on the work-monitor dashboard — any task, reminder, or hand-off worth not forgetting, for yourself or someone else (not limited to engineer hand-offs). Use whenever you or the user want something tracked on the board. Put any useful context in note.",
      inputSchema: {
        title: z.string().describe("Short title, e.g. 'Run bun run setup' or 'Hand off payments spec'"),
        note: z.string().optional().describe("Optional context — what's done, what's left, paths"),
        for_who: z.string().optional().describe("Optional — who it's for, if you're handing off to someone"),
        project: z.string().optional().describe("Optional project name"),
        branch: z.string().optional().describe("Optional git branch the work is on"),
        links: z.array(z.string()).optional().describe("Optional — spec paths, PR URLs, etc."),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(tools.add_todo(args as any)) }],
    })
  );

  server.registerTool(
    "list_todos",
    {
      description:
        "List todos on the work-monitor dashboard (optionally filtered by status) — e.g. to avoid creating duplicates or to check what's still open.",
      inputSchema: { status: z.enum(["todo", "done"]).optional() },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(tools.list_todos(args as any)) }],
    })
  );

  server.registerTool(
    "update_todo",
    {
      description:
        "Update a todo on the work-monitor dashboard — mark it done (or back to todo), or amend its note.",
      inputSchema: {
        id: z.string(),
        status: z.enum(["todo", "done"]).optional(),
        note: z.string().optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(tools.update_todo(args as any)) }],
    })
  );

  return server;
}
```
(Everything from `const transports` downward in `mcp.ts` is unchanged.)

- [ ] **Step 6: Update `tests/store.test.ts`**

(a) In "creates a todo in to_hand_off with incrementing position" (line 61), rename the title to drop the assertion mismatch and change the expected status. Replace:
```ts
  it("creates a todo in to_hand_off with incrementing position", () => {
    const a = store.createTodo({ title: "Hand off spec", note: "branch feat/pay" }, 5000);
    const b = store.createTodo({ title: "Review PR", note: "" }, 5001);
    expect(a.status).toBe("to_hand_off");
```
with:
```ts
  it("creates a todo in the 'todo' status with incrementing position", () => {
    const a = store.createTodo({ title: "Set a reminder", note: "branch feat/pay" }, 5000);
    const b = store.createTodo({ title: "Review PR", note: "" }, 5001);
    expect(a.status).toBe("todo");
```

(b) In "updates status and note" (line 76), change `"handed_off"` to `"done"`:
```ts
  it("updates status and note", () => {
    const t = store.createTodo({ title: "x", note: "n" }, 5000);
    const u = store.updateTodo(t.id, { status: "done", note: "passed to Sam" }, 6000)!;
    expect(u.status).toBe("done");
    expect(u.note).toBe("passed to Sam");
    expect(u.updated_at).toBe(6000);
  });
```

(c) In "filters by status" (line 84), change `listTodos("to_hand_off")` to `listTodos("todo")`:
```ts
    expect(store.listTodos("todo").length).toBe(1);
    expect(store.listTodos("done").length).toBe(1);
```

(d) Add a migration test. Change the import on line 2 to also import `migrate`:
```ts
import { openDb, migrate } from "../src/server/db.ts";
```
and add this `it` inside the `describe("Store todos", ...)` block:
```ts
  it("migrates legacy hand-off statuses to 'todo'", () => {
    const ins = (id: string, status: string) =>
      store.db
        .query(
          `INSERT INTO todos (id, title, note, status, position, created_at, updated_at)
           VALUES ($id, 't', '', $status, 0, 1, 1)`
        )
        .run({ $id: id, $status: status });
    ins("a", "handed_off");
    ins("b", "to_hand_off");
    ins("c", "done");
    migrate(store.db);
    const status = (id: string) =>
      (store.db.query(`SELECT status FROM todos WHERE id = $id`).get({ $id: id }) as { status: string }).status;
    expect(status("a")).toBe("todo");
    expect(status("b")).toBe("todo");
    expect(status("c")).toBe("done");
  });
```

- [ ] **Step 7: Update `tests/http.test.ts`**

(a) "creates, lists, updates and deletes a todo" (lines 52–75): change the created-status expectation and the PATCH target status from `handed_off` to `done`. Replace:
```ts
    expect(created.status).toBe("to_hand_off");

    const patched = await (
      await fetch(`${base}/api/todos/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "handed_off" }),
      })
    ).json() as any;
    expect(patched.status).toBe("handed_off");
```
with:
```ts
    expect(created.status).toBe("todo");

    const patched = await (
      await fetch(`${base}/api/todos/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      })
    ).json() as any;
    expect(patched.status).toBe("done");
```

(b) "rejects an invalid status on PATCH ... does not corrupt the card" (line 110): change the expected status from `to_hand_off` to `todo`:
```ts
    expect(state.todos[0].status).toBe("todo");
```

- [ ] **Step 8: Update `tests/mcp.test.ts`**

Replace the whole `describe("MCP tools", ...)` body so it uses the renamed tools, `todo`/`done` statuses, and covers the now-optional `note`:
```ts
describe("MCP tools", () => {
  it("add_todo creates a todo with origin + branch", () => {
    const { store, t } = tools();
    const out = t.add_todo({
      title: "Hand off feat/pay spec",
      note: "spec at docs/specs/pay.md",
      for_who: "Maria",
      project: "bov-frontend",
      branch: "feat/pay",
      links: ["docs/specs/pay.md"],
    });
    expect(out.id).toBeDefined();
    const todos = store.listTodos();
    expect(todos.length).toBe(1);
    expect(todos[0].status).toBe("todo");
    expect(todos[0].for_who).toBe("Maria");
    expect(todos[0].origin_project).toBe("bov-frontend");
    expect(todos[0].branch).toBe("feat/pay");
    expect(todos[0].links).toEqual(["docs/specs/pay.md"]);
  });

  it("add_todo works without a note", () => {
    const { store, t } = tools();
    const out = t.add_todo({ title: "Run bun run setup" });
    expect(out.id).toBeDefined();
    expect(store.listTodos()[0].note).toBe("");
  });

  it("list_todos returns current todos, optionally filtered", () => {
    const { t } = tools();
    t.add_todo({ title: "a" });
    const all = t.list_todos({});
    expect(all.todos.length).toBe(1);
    const none = t.list_todos({ status: "done" });
    expect(none.todos.length).toBe(0);
  });

  it("update_todo changes status", () => {
    const { store, t } = tools();
    const { id } = t.add_todo({ title: "a" });
    const out = t.update_todo({ id, status: "done" });
    expect(out.ok).toBe(true);
    expect(store.getTodo(id)!.status).toBe("done");
  });

  it("update_todo on a missing id returns ok:false", () => {
    const { t } = tools();
    expect(t.update_todo({ id: "nope", status: "done" }).ok).toBe(false);
  });
});
```

- [ ] **Step 9: Update `tests/mcp-http.test.ts`**

(a) "lists the three tools" (line 40): the sorted names become the new set:
```ts
    expect(names).toEqual(["add_todo", "list_todos", "update_todo"]);
```
(b) "record_handoff creates a todo via a real tool call" (lines 44–53): rename the test + the tool call:
```ts
  it("add_todo creates a todo via a real tool call", async () => {
    const { client, transport } = await connect();
    await client.callTool({
      name: "add_todo",
      arguments: { title: "Hand off", note: "ctx", for_who: "Maria" },
    });
    expect(store.listTodos().length).toBe(1);
    expect(store.listTodos()[0].for_who).toBe("Maria");
    await transport.close();
  });
```

- [ ] **Step 10: Run server tests + typecheck**

Run: `bun run test`
Expected: all server tests pass (the renamed MCP tests, the migration test, store/http with `todo`/`done`).

Run: `bun run typecheck`
Expected: clean (both tsconfigs — web is untouched and still internally consistent).

- [ ] **Step 11: Commit**

```bash
git add src/server tests
git commit -m "feat(server): generalize hand-off tools to add_todo/list_todos/update_todo; statuses todo/done + migration"
```

---

## Task 2: Web — statuses + 2-column todo board

**Files:**
- Modify: `src/web/types.ts`, `src/web/drag.ts`, `src/web/components/Board.tsx`, `src/web/components/AppBar.tsx`
- Modify (tests): `web-tests/drag.test.ts`, `web-tests/Board.test.tsx`, `web-tests/AppBar.test.tsx`

- [ ] **Step 1: Narrow the web `TodoStatus`**

In `src/web/types.ts` line 2, change:
```ts
export type TodoStatus = "to_hand_off" | "handed_off" | "done";
```
to:
```ts
export type TodoStatus = "todo" | "done";
```

- [ ] **Step 2: Update drag statuses**

In `src/web/drag.ts` line 3, change:
```ts
const STATUSES: TodoStatus[] = ["to_hand_off", "handed_off", "done"];
```
to:
```ts
const STATUSES: TodoStatus[] = ["todo", "done"];
```

- [ ] **Step 3: Board — 2 columns + lane label**

In `src/web/components/Board.tsx`, replace the `TODO_COLS` definition (lines 10–14):
```ts
const TODO_COLS: { id: TodoStatus; title: string; dot: string }[] = [
  { id: "to_hand_off", title: "To hand off", dot: "bg-attention" },
  { id: "handed_off", title: "Handed off", dot: "bg-handed" },
  { id: "done", title: "Done", dot: "bg-done" },
];
```
with:
```ts
const TODO_COLS: { id: TodoStatus; title: string; dot: string }[] = [
  { id: "todo", title: "To do", dot: "bg-attention" },
  { id: "done", title: "Done", dot: "bg-done" },
];
```
And change the lane label on line 36 from `label="★ Hand-offs & todos"` to `label="★ Todos"`:
```tsx
        <Lane label="★ Todos" hint="manual — drag cards as you deal with them">
```

- [ ] **Step 4: AppBar — "to do" count**

In `src/web/components/AppBar.tsx`, change line 17:
```ts
  const toHandOff = state.todos.filter((t) => t.status === "to_hand_off").length;
```
to:
```ts
  const todoCount = state.todos.filter((t) => t.status === "todo").length;
```
and change the third count chip (line 31) from:
```tsx
        <Count dotClass="bg-attention" label="to hand off" n={toHandOff} />
```
to:
```tsx
        <Count dotClass="bg-attention" label="to do" n={todoCount} />
```

- [ ] **Step 5: Update `web-tests/drag.test.ts`**

Replace the `describe("resolveDrop", ...)` body so the cases use `todo`/`done`:
```ts
describe("resolveDrop", () => {
  it("returns a status patch when dropped on a different column", () => {
    expect(resolveDrop([todo("t1", "todo")], "t1", "done")).toEqual({ id: "t1", status: "done" });
  });
  it("returns null when dropped on its own column", () => {
    expect(resolveDrop([todo("t1", "todo")], "t1", "todo")).toBeNull();
  });
  it("returns null for a non-column target, a missing target, or a missing todo", () => {
    expect(resolveDrop([todo("t1", "todo")], "t1", null)).toBeNull();
    expect(resolveDrop([todo("t1", "todo")], "t1", "sess-working")).toBeNull();
    expect(resolveDrop([], "t1", "done")).toBeNull();
  });
});
```

- [ ] **Step 6: Update `web-tests/Board.test.tsx`**

Change the seeded todo's status from `"to_hand_off"` to `"todo"` (the todo line in the `state` fixture):
```ts
    { id: "t1", title: "Hand off spec", note: "branch feat/pay", for_who: "Maria", status: "todo", origin_project: "bov", branch: "feat/pay", links: null, position: 0 },
```
(The text assertions — `"Hand off spec"`, `"→ Maria"`, the session texts — are unchanged and still pass; the card now renders in the "To do" column.)

- [ ] **Step 7: Update `web-tests/AppBar.test.tsx`**

(a) Change the seeded todo status (line 12) from `"to_hand_off"` to `"todo"`:
```ts
    { id: "t1", title: "t", note: "", for_who: null, status: "todo", origin_project: null, branch: null, links: null, position: 0 },
```
(b) Change the count assertion (line 26) from:
```ts
    expect(screen.getByText("1 to hand off")).toBeDefined();
```
to:
```ts
    expect(screen.getByText("1 to do")).toBeDefined();
```

- [ ] **Step 8: Run web tests + typecheck + build**

Run: `bun run web:test`
Expected: PASS — `Board.test.tsx`, `AppBar.test.tsx`, `drag.test.ts`, `useTheme.test.ts` all green.

Run: `bun run typecheck`
Expected: clean.

Run: `bun run web:build`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/web web-tests
git commit -m "feat(web): 2-column Todos lane (todo/done), 'to do' count chip"
```

---

## Task 3: Docs + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Read `README.md`, then update the hand-off framing to the generic todo tooling. Specifically:
- The tools line (currently `... tools \`record_handoff\`, \`list_todos\`, \`update_handoff\`;`) → `... tools \`add_todo\`, \`list_todos\`, \`update_todo\`;`.
- The "Agents record hand-off todos via an MCP tool (`record_handoff`) — just say *\"set a hand-off todo for this\"*" line → describe a generic todo, e.g. "Agents record todos via an MCP tool (`add_todo`) — just say *\"add a todo for this\"* — for any task, reminder, or hand-off; the agent fills in the context (branch, spec path, what's left, who it's for).".
- The board description "**hand-offs on top** (you drag through `To hand off → Handed off → Done`)" → "**todos on top** (you drag through `To do → Done`)".
- Any other "hand-off"/"hand-offs" phrasing in the intro/overview → "todo"/"todos" as reads naturally. Leave the design/plan docs under `docs/superpowers/` untouched.

- [ ] **Step 2: Full verification**

Run: `bun run test` → all server tests pass.
Run: `bun run web:test` → all web tests pass.
Run: `bun run typecheck` → clean (both tsconfigs).
Run: `bun run web:build` → build succeeds.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): describe add_todo/list_todos/update_todo and the To do/Done board"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** tool rename + descriptions + optional note (Task 1 Step 5); `todo`/`done` statuses in both `TodoStatus` defs (Task 1 Step 1, Task 2 Step 1); DB default + idempotent migration + migration test (Task 1 Steps 2, 6d); store/http status updates (Task 1 Steps 3–4); 2-column board + lane label + AppBar chip (Task 2 Steps 3–4); README (Task 3). All test files that referenced legacy statuses or the old tool names are updated.
- **No stale references:** after Task 1, `bun run test` + `typecheck` are green because every server file and server test that named `to_hand_off`/`handed_off`/`record_handoff`/`update_handoff` is updated in the same task; web is untouched and self-consistent. After Task 2 the web half is likewise fully migrated. No intermediate broken state.
- **Hidden gotcha handled:** `tests/http.test.ts` PATCHed `status:"handed_off"` and asserted it — that status no longer validates (would now 400), so it is switched to `"done"` (Task 1 Step 7a).
- **Type/name consistency:** the MCP impl keys (`add_todo`/`list_todos`/`update_todo`) match the `registerTool` names and the test call sites; the sorted registry list `["add_todo","list_todos","update_todo"]` matches the new names; `note` is optional in both the Zod schema and the impl input type.
- **Non-goals respected:** no alias for old names; no change to sessions/hooks/SSE/REST shape beyond the status enum; no new deps; `Todo` fields unchanged.
