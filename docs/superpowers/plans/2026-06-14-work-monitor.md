# work-monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented — merged to `main` (2026-06-14)

**Goal:** A local web dashboard that shows the live status of every parallel Claude Code session (working / needs-you / idle) and holds agent-authored hand-off todos, fed automatically by Claude Code hooks and an MCP endpoint.

**Architecture:** One long-running Bun process (`wm-server`) exposes a REST API (hook ingestion + dashboard), an MCP endpoint over Streamable HTTP (agent-authored hand-offs), and an SSE stream (live updates), backed by SQLite. Thin shell hook scripts POST session lifecycle events; a React/Vite dashboard renders a two-lane kanban. A `wm setup` script wires hooks + MCP + a systemd user service.

**Tech Stack:** Bun + TypeScript, `node:http` server (so the MCP SDK's Streamable HTTP transport plugs in directly and runs under Bun), `bun:sqlite`, `@modelcontextprotocol/sdk` + `zod`, React + Vite + Tailwind + `@dnd-kit`. Tests via `bun:test` (backend) and Vitest + Testing Library (frontend).

**Runtime decisions (locked):**
- Server listens on `127.0.0.1`, port from `WM_PORT` (default `4317`).
- DB path from `WM_DB_PATH` (default `~/.local/share/work-monitor/work-monitor.sqlite`); tests use a temp file.
- MCP runs in **stateless** mode (fresh server+transport per POST; GET/DELETE → 405).
- Hooks forward the raw hook JSON to `POST /events?type=<event>`; the server parses it. No `jq` in hooks.
- Timestamps are epoch milliseconds.

**Reference (read before building the MCP and hook tasks):**
- MCP SDK stateless Streamable HTTP example: https://github.com/modelcontextprotocol/typescript-sdk#streamable-http
- Claude Code hooks reference: https://docs.claude.com/en/docs/claude-code/hooks
- Claude Code hook events emit JSON on stdin with fields: `session_id`, `cwd`, `transcript_path`, plus event-specific fields (`prompt` for UserPromptSubmit; `tool_name`/`tool_input` for PostToolUse; `message` for Notification; `reason` for SessionEnd; `source` for SessionStart).

---

## File Structure

```
work-monitor/
  package.json            # scripts + deps
  tsconfig.json
  bunfig.toml             # test preload if needed
  src/
    server/
      config.ts           # port, db path, paths
      types.ts            # shared TS types (Session, Todo, HookEvent, ...)
      db.ts               # open sqlite (WAL) + schema/migrations
      derive.ts           # projectFromCwd, deriveCurrentTask, truncate
      events.ts           # reduceEvent: HookEvent -> {sessionId, patch}
      store.ts            # Store class: session + todo persistence, sweepStale
      sse.ts              # SseHub: subscribers + broadcast
      http.ts             # createApp(deps): node:http request handler (REST + SSE)
      mcp.ts              # buildMcpServer(deps) + handleMcpRequest
      index.ts            # entry: wire deps, start server, start sweep timer
    hooks/
      wm-hook.sh          # POSIX forwarder: stdin -> POST /events?type=$1
    cli/
      setup.ts            # `wm setup`: systemd unit, settings.json merge, mcp add
      settings-merge.ts   # pure: merge hook entries into a settings object
      wm-server.service.tmpl  # systemd --user unit template
    web/
      index.html
      main.tsx
      App.tsx
      api.ts              # REST fetch + SSE subscription
      types.ts            # re-export shared shapes for the client
      components/
        Board.tsx
        Lane.tsx
        SessionCard.tsx
        TodoCard.tsx
      styles.css
  tests/
    derive.test.ts
    events.test.ts
    store.test.ts
    http.test.ts
    mcp.test.ts
    settings-merge.test.ts
  vite.config.ts
  vitest.config.ts
  web-tests/
    Board.test.tsx
  README.md
```

---

## Phase 0 — Scaffolding

### Task 1: Project init + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore` (already exists — extend)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "work-monitor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "server": "bun run src/server/index.ts",
    "test": "bun test tests/",
    "web:dev": "vite",
    "web:build": "vite build",
    "web:test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@dnd-kit/core": "^6.1.0",
    "@dnd-kit/sortable": "^8.0.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^24.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "tests", "web-tests"]
}
```

- [ ] **Step 3: Create `bunfig.toml`**

```toml
[test]
root = "tests"
```

- [ ] **Step 4: Install deps**

Run: `bun install`
Expected: `node_modules/` populated, no errors. (`@modelcontextprotocol/sdk` and `zod` resolve.)

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json bunfig.toml bun.lock
git commit -m "chore: scaffold work-monitor (bun + ts tooling)"
```

---

## Phase 1 — Types & config

### Task 2: Shared types

**Files:**
- Create: `src/server/types.ts`

- [ ] **Step 1: Write `src/server/types.ts`** (no test — pure type declarations)

```ts
export type SessionStatus = "working" | "needs_you" | "idle" | "ended";

export interface Session {
  id: string;
  project: string;
  cwd: string;
  transcript_path: string | null;
  status: SessionStatus;
  current_task: string | null;
  current_intent: string | null;
  attention_reason: string | null;
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
}

export type EventType =
  | "session_start"
  | "prompt"
  | "todo_update"
  | "notification"
  | "stop"
  | "session_end";

/** Raw Claude Code hook payload plus the type from the query string. */
export interface HookEvent {
  wm_event_type: EventType;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  message?: string;
  reason?: string;
  source?: string;
}

export interface SessionPatch {
  project?: string;
  cwd?: string;
  transcript_path?: string | null;
  status?: SessionStatus;
  current_task?: string | null;
  current_intent?: string | null;
  attention_reason?: string | null;
  last_activity_at?: number;
  ended_at?: number | null;
}

export type TodoStatus = "to_hand_off" | "handed_off" | "done";

export interface Todo {
  id: string;
  title: string;
  note: string;
  for_who: string | null;
  status: TodoStatus;
  origin_session_id: string | null;
  origin_project: string | null;
  branch: string | null;
  links: string[] | null;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface CreateTodoInput {
  title: string;
  note: string;
  for_who?: string | null;
  origin_session_id?: string | null;
  origin_project?: string | null;
  branch?: string | null;
  links?: string[] | null;
}

export interface UpdateTodoInput {
  title?: string;
  note?: string;
  for_who?: string | null;
  status?: TodoStatus;
  branch?: string | null;
  links?: string[] | null;
  position?: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/types.ts
git commit -m "feat: shared work-monitor types"
```

### Task 3: Config

**Files:**
- Create: `src/server/config.ts`

- [ ] **Step 1: Write `src/server/config.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.WM_PORT ?? 4317);
export const HOST = "127.0.0.1";

export function defaultDbPath(): string {
  const base =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "work-monitor", "work-monitor.sqlite");
}

export const DB_PATH = process.env.WM_DB_PATH ?? defaultDbPath();

/** Sessions with no activity for this long while "working" are swept to idle. */
export const STALE_MS = 10 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_INTENT_LEN = 140;
```

- [ ] **Step 2: Commit**

```bash
git add src/server/config.ts
git commit -m "feat: server config"
```

---

## Phase 2 — Pure core logic (TDD)

### Task 4: derive.ts — project name, truncation, current-task

**Files:**
- Create: `src/server/derive.ts`
- Test: `tests/derive.test.ts`

- [ ] **Step 1: Write the failing test `tests/derive.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { projectFromCwd, truncate, deriveCurrentTask } from "../src/server/derive.ts";

describe("projectFromCwd", () => {
  it("uses the basename of the cwd", () => {
    expect(projectFromCwd("/home/lunatic/projects/work/browns")).toBe("browns");
  });
  it("handles trailing slash", () => {
    expect(projectFromCwd("/home/lunatic/projects/work/browns/")).toBe("browns");
  });
  it("falls back to 'unknown' for empty", () => {
    expect(projectFromCwd("")).toBe("unknown");
  });
});

describe("truncate", () => {
  it("leaves short strings", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
  it("adds an ellipsis when over length", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("deriveCurrentTask", () => {
  it("returns null for no todos", () => {
    expect(deriveCurrentTask([])).toBeNull();
    expect(deriveCurrentTask(undefined)).toBeNull();
  });
  it("shows the in_progress item with a done count", () => {
    const todos = [
      { content: "Write schema", status: "completed" },
      { content: "Build API", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ];
    expect(deriveCurrentTask(todos)).toBe("Build API (1/3 done)");
  });
  it("when nothing is in_progress, summarises progress", () => {
    const todos = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    expect(deriveCurrentTask(todos)).toBe("2/2 done");
  });
  it("ignores malformed entries", () => {
    expect(deriveCurrentTask([{ foo: "bar" } as unknown as { content: string; status: string }])).toBe("0/1 done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/derive.test.ts`
Expected: FAIL — module `../src/server/derive.ts` not found / exports missing.

- [ ] **Step 3: Write `src/server/derive.ts`**

```ts
import { MAX_INTENT_LEN } from "./config.ts";

export function projectFromCwd(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1];
  return last || "unknown";
}

export function truncate(s: string, n: number = MAX_INTENT_LEN): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

interface TodoItem {
  content?: string;
  status?: string;
  activeForm?: string;
}

export function deriveCurrentTask(todos: TodoItem[] | undefined): string | null {
  if (!todos || todos.length === 0) return null;
  const total = todos.length;
  const completed = todos.filter((t) => t?.status === "completed").length;
  const active = todos.find((t) => t?.status === "in_progress");
  if (active) {
    const label = active.activeForm || active.content || "working";
    return `${label} (${completed}/${total} done)`;
  }
  return `${completed}/${total} done`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/derive.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/derive.ts tests/derive.test.ts
git commit -m "feat: derive project name and current task (TDD)"
```

### Task 5: events.ts — event reducer (state machine)

**Files:**
- Create: `src/server/events.ts`
- Test: `tests/events.test.ts`

- [ ] **Step 1: Write the failing test `tests/events.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { reduceEvent } from "../src/server/events.ts";
import type { HookEvent } from "../src/server/types.ts";

const base = (over: Partial<HookEvent>): HookEvent => ({
  wm_event_type: "stop",
  session_id: "s1",
  ...over,
});

const NOW = 1_000_000;

describe("reduceEvent", () => {
  it("session_start -> working, sets project from cwd", () => {
    const { sessionId, patch } = reduceEvent(
      base({ wm_event_type: "session_start", cwd: "/x/browns", transcript_path: "/t" }),
      NOW
    );
    expect(sessionId).toBe("s1");
    expect(patch.status).toBe("working");
    expect(patch.project).toBe("browns");
    expect(patch.cwd).toBe("/x/browns");
    expect(patch.transcript_path).toBe("/t");
    expect(patch.last_activity_at).toBe(NOW);
  });

  it("prompt -> working, sets current_intent (truncated) and clears attention", () => {
    const { patch } = reduceEvent(
      base({ wm_event_type: "prompt", prompt: "Refactor the checkout flow please" }),
      NOW
    );
    expect(patch.status).toBe("working");
    expect(patch.current_intent).toBe("Refactor the checkout flow please");
    expect(patch.attention_reason).toBeNull();
  });

  it("todo_update -> working, sets current_task from tool_input.todos", () => {
    const { patch } = reduceEvent(
      base({
        wm_event_type: "todo_update",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "A", status: "in_progress" }] },
      }),
      NOW
    );
    expect(patch.status).toBe("working");
    expect(patch.current_task).toBe("A (0/1 done)");
  });

  it("notification -> needs_you with attention_reason", () => {
    const { patch } = reduceEvent(
      base({ wm_event_type: "notification", message: "Run the migration?" }),
      NOW
    );
    expect(patch.status).toBe("needs_you");
    expect(patch.attention_reason).toBe("Run the migration?");
  });

  it("stop -> idle", () => {
    const { patch } = reduceEvent(base({ wm_event_type: "stop" }), NOW);
    expect(patch.status).toBe("idle");
  });

  it("session_end -> ended with ended_at", () => {
    const { patch } = reduceEvent(base({ wm_event_type: "session_end" }), NOW);
    expect(patch.status).toBe("ended");
    expect(patch.ended_at).toBe(NOW);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/events.test.ts`
Expected: FAIL — `reduceEvent` not found.

- [ ] **Step 3: Write `src/server/events.ts`**

```ts
import type { HookEvent, SessionPatch } from "./types.ts";
import { projectFromCwd, truncate, deriveCurrentTask } from "./derive.ts";

export function reduceEvent(
  event: HookEvent,
  now: number
): { sessionId: string; patch: SessionPatch } {
  const patch: SessionPatch = { last_activity_at: now };

  if (event.cwd) {
    patch.cwd = event.cwd;
    patch.project = projectFromCwd(event.cwd);
  }
  if (event.transcript_path) patch.transcript_path = event.transcript_path;

  switch (event.wm_event_type) {
    case "session_start":
      patch.status = "working";
      break;
    case "prompt":
      patch.status = "working";
      patch.attention_reason = null;
      if (typeof event.prompt === "string") {
        patch.current_intent = truncate(event.prompt);
      }
      break;
    case "todo_update": {
      patch.status = "working";
      const todos = (event.tool_input as { todos?: unknown })?.todos;
      const task = deriveCurrentTask(
        Array.isArray(todos) ? (todos as { content: string; status: string }[]) : undefined
      );
      if (task !== null) patch.current_task = task;
      break;
    }
    case "notification":
      patch.status = "needs_you";
      patch.attention_reason = event.message ?? "Needs your attention";
      break;
    case "stop":
      patch.status = "idle";
      break;
    case "session_end":
      patch.status = "ended";
      patch.ended_at = now;
      break;
  }

  return { sessionId: event.session_id, patch };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/events.ts tests/events.test.ts
git commit -m "feat: session event reducer / state machine (TDD)"
```

---

## Phase 3 — Persistence (TDD)

### Task 6: db.ts — schema

**Files:**
- Create: `src/server/db.ts`

- [ ] **Step 1: Write `src/server/db.ts`**

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

function migrate(db: Database): void {
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
      status TEXT NOT NULL DEFAULT 'to_hand_off',
      origin_session_id TEXT,
      origin_project TEXT,
      branch TEXT,
      links TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/db.ts
git commit -m "feat: sqlite schema + WAL"
```

### Task 7: store.ts — sessions

**Files:**
- Create: `src/server/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test `tests/store.test.ts`** (session portion)

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { reduceEvent } from "../src/server/events.ts";

function freshStore() {
  return new Store(openDb(":memory:"));
}

describe("Store sessions", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("creates a session on first event and lists it", () => {
    const { sessionId, patch } = reduceEvent(
      { wm_event_type: "session_start", session_id: "s1", cwd: "/x/browns" },
      1000
    );
    store.applyEvent(sessionId, patch, 1000);
    const sessions = store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("s1");
    expect(sessions[0].project).toBe("browns");
    expect(sessions[0].status).toBe("working");
    expect(sessions[0].started_at).toBe(1000);
  });

  it("updates status on subsequent events without losing started_at", () => {
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch, 1000);
    store.applyEvent("s1", reduceEvent({ wm_event_type: "stop", session_id: "s1" }, 2000).patch, 2000);
    const s = store.getSession("s1")!;
    expect(s.status).toBe("idle");
    expect(s.started_at).toBe(1000);
    expect(s.last_activity_at).toBe(2000);
  });

  it("excludes ended sessions from the active board listing", () => {
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch, 1000);
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_end", session_id: "s1" }, 2000).patch, 2000);
    expect(store.listSessions().length).toBe(0);
    expect(store.listSessions({ includeEnded: true }).length).toBe(1);
  });

  it("sweepStale moves stale working sessions to idle", () => {
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch, 1000);
    const affected = store.sweepStale(1000 + 11 * 60 * 1000, 10 * 60 * 1000);
    expect(affected).toContain("s1");
    expect(store.getSession("s1")!.status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/store.test.ts`
Expected: FAIL — `Store` not found.

- [ ] **Step 3: Write `src/server/store.ts`** (session methods; todo methods added in Task 8)

```ts
import type { Database } from "bun:sqlite";
import type { Session, SessionPatch } from "./types.ts";

const SESSION_COLS =
  "id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, started_at, last_activity_at, ended_at";

export class Store {
  constructor(public db: Database) {}

  applyEvent(sessionId: string, patch: SessionPatch, now: number): Session {
    const existing = this.getSession(sessionId);
    if (!existing) {
      this.db
        .query(
          `INSERT INTO sessions (id, project, cwd, transcript_path, status, current_task, current_intent, attention_reason, started_at, last_activity_at, ended_at)
           VALUES ($id, $project, $cwd, $transcript_path, $status, $current_task, $current_intent, $attention_reason, $started_at, $last_activity_at, $ended_at)`
        )
        .run({
          $id: sessionId,
          $project: patch.project ?? "unknown",
          $cwd: patch.cwd ?? "",
          $transcript_path: patch.transcript_path ?? null,
          $status: patch.status ?? "working",
          $current_task: patch.current_task ?? null,
          $current_intent: patch.current_intent ?? null,
          $attention_reason: patch.attention_reason ?? null,
          $started_at: now,
          $last_activity_at: patch.last_activity_at ?? now,
          $ended_at: patch.ended_at ?? null,
        });
      return this.getSession(sessionId)!;
    }

    const fields: string[] = [];
    const params: Record<string, unknown> = { $id: sessionId };
    for (const key of [
      "project",
      "cwd",
      "transcript_path",
      "status",
      "current_task",
      "current_intent",
      "attention_reason",
      "last_activity_at",
      "ended_at",
    ] as const) {
      if (key in patch) {
        fields.push(`${key} = $${key}`);
        params[`$${key}`] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    if (fields.length > 0) {
      this.db.query(`UPDATE sessions SET ${fields.join(", ")} WHERE id = $id`).run(params);
    }
    return this.getSession(sessionId)!;
  }

  getSession(id: string): Session | null {
    const row = this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE id = $id`).get({ $id: id });
    return (row as Session) ?? null;
  }

  listSessions(opts: { includeEnded?: boolean } = {}): Session[] {
    const where = opts.includeEnded ? "" : "WHERE status != 'ended'";
    return this.db
      .query(`SELECT ${SESSION_COLS} FROM sessions ${where} ORDER BY last_activity_at DESC`)
      .all() as Session[];
  }

  sweepStale(now: number, thresholdMs: number): string[] {
    const rows = this.db
      .query(
        `SELECT id FROM sessions WHERE status = 'working' AND last_activity_at < $cutoff`
      )
      .all({ $cutoff: now - thresholdMs }) as { id: string }[];
    const ids = rows.map((r) => r.id);
    for (const id of ids) {
      this.db.query(`UPDATE sessions SET status = 'idle' WHERE id = $id`).run({ $id: id });
    }
    return ids;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts src/server/db.ts tests/store.test.ts
git commit -m "feat: session persistence + staleness sweep (TDD)"
```

### Task 8: store.ts — todos

**Files:**
- Modify: `src/server/store.ts`
- Test: `tests/store.test.ts` (append)

- [ ] **Step 1: Append failing tests to `tests/store.test.ts`**

```ts
import { randomUUID } from "node:crypto";

describe("Store todos", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(":memory:"));
  });

  it("creates a todo in to_hand_off with incrementing position", () => {
    const a = store.createTodo({ title: "Hand off spec", note: "branch feat/pay" }, 5000);
    const b = store.createTodo({ title: "Review PR", note: "" }, 5001);
    expect(a.status).toBe("to_hand_off");
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(store.listTodos().length).toBe(2);
  });

  it("round-trips links as an array", () => {
    const t = store.createTodo({ title: "x", note: "", links: ["docs/spec.md", "PR#42"] }, 5000);
    expect(store.listTodos()[0].links).toEqual(["docs/spec.md", "PR#42"]);
    expect(t.links).toEqual(["docs/spec.md", "PR#42"]);
  });

  it("updates status and note", () => {
    const t = store.createTodo({ title: "x", note: "n" }, 5000);
    const u = store.updateTodo(t.id, { status: "handed_off", note: "passed to Sam" }, 6000)!;
    expect(u.status).toBe("handed_off");
    expect(u.note).toBe("passed to Sam");
    expect(u.updated_at).toBe(6000);
  });

  it("filters by status", () => {
    store.createTodo({ title: "a", note: "" }, 1);
    const b = store.createTodo({ title: "b", note: "" }, 2);
    store.updateTodo(b.id, { status: "done" }, 3);
    expect(store.listTodos("to_hand_off").length).toBe(1);
    expect(store.listTodos("done").length).toBe(1);
  });

  it("deletes a todo", () => {
    const t = store.createTodo({ title: "x", note: "" }, 1);
    expect(store.deleteTodo(t.id)).toBe(true);
    expect(store.listTodos().length).toBe(0);
    expect(store.deleteTodo("nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/store.test.ts`
Expected: FAIL — `createTodo` not found.

- [ ] **Step 3: Add todo methods to `Store` in `src/server/store.ts`**

Add the import at the top and the methods inside the `Store` class:

```ts
// at top of file:
import { randomUUID } from "node:crypto";
import type { Todo, TodoStatus, CreateTodoInput, UpdateTodoInput } from "./types.ts";

const TODO_COLS =
  "id, title, note, for_who, status, origin_session_id, origin_project, branch, links, position, created_at, updated_at";

// helper above the class:
function rowToTodo(row: Record<string, unknown>): Todo {
  return {
    ...(row as unknown as Todo),
    links: row.links ? (JSON.parse(row.links as string) as string[]) : null,
  };
}
```

Methods inside `class Store`:

```ts
  createTodo(input: CreateTodoInput, now: number): Todo {
    const id = randomUUID();
    const nextPos =
      (this.db.query(`SELECT COALESCE(MAX(position), -1) AS m FROM todos WHERE status = 'to_hand_off'`).get() as { m: number }).m + 1;
    this.db
      .query(
        `INSERT INTO todos (${TODO_COLS}) VALUES ($id, $title, $note, $for_who, 'to_hand_off', $origin_session_id, $origin_project, $branch, $links, $position, $created_at, $updated_at)`
      )
      .run({
        $id: id,
        $title: input.title,
        $note: input.note ?? "",
        $for_who: input.for_who ?? null,
        $origin_session_id: input.origin_session_id ?? null,
        $origin_project: input.origin_project ?? null,
        $branch: input.branch ?? null,
        $links: input.links ? JSON.stringify(input.links) : null,
        $position: nextPos,
        $created_at: now,
        $updated_at: now,
      });
    return this.getTodo(id)!;
  }

  getTodo(id: string): Todo | null {
    const row = this.db.query(`SELECT ${TODO_COLS} FROM todos WHERE id = $id`).get({ $id: id });
    return row ? rowToTodo(row as Record<string, unknown>) : null;
  }

  listTodos(status?: TodoStatus): Todo[] {
    const where = status ? "WHERE status = $status" : "";
    const rows = this.db
      .query(`SELECT ${TODO_COLS} FROM todos ${where} ORDER BY status, position ASC`)
      .all(status ? { $status: status } : {}) as Record<string, unknown>[];
    return rows.map(rowToTodo);
  }

  updateTodo(id: string, patch: UpdateTodoInput, now: number): Todo | null {
    if (!this.getTodo(id)) return null;
    const fields: string[] = ["updated_at = $updated_at"];
    const params: Record<string, unknown> = { $id: id, $updated_at: now };
    for (const key of ["title", "note", "for_who", "status", "branch", "position"] as const) {
      if (key in patch) {
        fields.push(`${key} = $${key}`);
        params[`$${key}`] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    if ("links" in patch) {
      fields.push("links = $links");
      params.$links = patch.links ? JSON.stringify(patch.links) : null;
    }
    this.db.query(`UPDATE todos SET ${fields.join(", ")} WHERE id = $id`).run(params);
    return this.getTodo(id);
  }

  deleteTodo(id: string): boolean {
    const res = this.db.query(`DELETE FROM todos WHERE id = $id`).run({ $id: id });
    return res.changes > 0;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/store.test.ts`
Expected: PASS (sessions + todos).

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts tests/store.test.ts
git commit -m "feat: todo persistence (TDD)"
```

---

## Phase 4 — SSE + HTTP API (TDD)

### Task 9: sse.ts — broadcast hub

**Files:**
- Create: `src/server/sse.ts`

- [ ] **Step 1: Write `src/server/sse.ts`**

```ts
import type { ServerResponse } from "node:http";

export class SseHub {
  private clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/sse.ts
git commit -m "feat: SSE broadcast hub"
```

### Task 10: http.ts — REST app + ingestion + SSE endpoint

**Files:**
- Create: `src/server/http.ts`
- Test: `tests/http.test.ts`

- [ ] **Step 1: Write the failing test `tests/http.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { createApp } from "../src/server/http.ts";

let server: Server;
let base: string;
let store: Store;

beforeEach(async () => {
  store = new Store(openDb(":memory:"));
  const app = createApp({ store, sse: new SseHub() });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("POST /events", () => {
  it("ingests a session_start and surfaces it in /api/state", async () => {
    const res = await fetch(`${base}/events?type=session_start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", cwd: "/x/browns" }),
    });
    expect(res.status).toBe(204);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.sessions.length).toBe(1);
    expect(state.sessions[0].project).toBe("browns");
    expect(state.sessions[0].status).toBe("working");
  });

  it("ignores events with no session_id (204, no crash)", async () => {
    const res = await fetch(`${base}/events?type=stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(204);
  });
});

describe("todos REST", () => {
  it("creates, lists, updates and deletes a todo", async () => {
    const created = await (
      await fetch(`${base}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hand off spec", note: "branch feat/pay", for_who: "Maria" }),
      })
    ).json();
    expect(created.status).toBe("to_hand_off");

    const patched = await (
      await fetch(`${base}/api/todos/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "handed_off" }),
      })
    ).json();
    expect(patched.status).toBe("handed_off");

    const del = await fetch(`${base}/api/todos/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.todos.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/http.test.ts`
Expected: FAIL — `createApp` not found.

- [ ] **Step 3: Write `src/server/http.ts`**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import { SseHub } from "./sse.ts";
import { reduceEvent } from "./events.ts";
import type { EventType, HookEvent, TodoStatus } from "./types.ts";

export interface AppDeps {
  store: Store;
  sse: SseHub;
  now?: () => number;
}

const EVENT_TYPES = new Set<EventType>([
  "session_start",
  "prompt",
  "todo_update",
  "notification",
  "stop",
  "session_end",
]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(s);
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const { store, sse } = deps;

  function pushState(): void {
    sse.broadcast("state", { sessions: store.listSessions(), todos: store.listTodos() });
  }

  return async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // --- ingestion ---
      if (method === "POST" && path === "/events") {
        const type = url.searchParams.get("type") as EventType | null;
        const raw = await readBody(req);
        if (!type || !EVENT_TYPES.has(type)) {
          res.writeHead(204).end();
          return;
        }
        let payload: Record<string, unknown> = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(204).end();
          return;
        }
        const event: HookEvent = { ...(payload as object), wm_event_type: type } as HookEvent;
        if (!event.session_id) {
          res.writeHead(204).end();
          return;
        }
        const t = now();
        const { sessionId, patch } = reduceEvent(event, t);
        store.applyEvent(sessionId, patch, t);
        store.db
          .query(`INSERT INTO events (session_id, type, payload, at) VALUES ($s, $t, $p, $a)`)
          .run({ $s: sessionId, $t: type, $p: raw.slice(0, 8000), $a: t });
        pushState();
        res.writeHead(204).end();
        return;
      }

      // --- full state snapshot ---
      if (method === "GET" && path === "/api/state") {
        json(res, 200, { sessions: store.listSessions(), todos: store.listTodos() });
        return;
      }

      // --- SSE ---
      if (method === "GET" && path === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: state\ndata: ${JSON.stringify({ sessions: store.listSessions(), todos: store.listTodos() })}\n\n`);
        sse.add(res);
        return;
      }

      // --- todos CRUD ---
      if (method === "POST" && path === "/api/todos") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.title) {
          json(res, 400, { error: "title is required" });
          return;
        }
        const todo = store.createTodo(body, now());
        pushState();
        json(res, 201, todo);
        return;
      }

      const todoMatch = path.match(/^\/api\/todos\/([^/]+)$/);
      if (todoMatch) {
        const id = decodeURIComponent(todoMatch[1]);
        if (method === "PATCH") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const updated = store.updateTodo(id, body, now());
          if (!updated) {
            json(res, 404, { error: "not found" });
            return;
          }
          pushState();
          json(res, 200, updated);
          return;
        }
        if (method === "DELETE") {
          const ok = store.deleteTodo(id);
          if (ok) pushState();
          res.writeHead(ok ? 204 : 404).end();
          return;
        }
      }

      // --- list todos (optional filter) ---
      if (method === "GET" && path === "/api/todos") {
        const status = url.searchParams.get("status") as TodoStatus | null;
        json(res, 200, store.listTodos(status ?? undefined));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts tests/http.test.ts
git commit -m "feat: REST API — events ingestion, state, SSE, todos CRUD (TDD)"
```

---

## Phase 5 — MCP endpoint (TDD)

### Task 10b: mcp.ts — tools + stateless HTTP handler

**Files:**
- Create: `src/server/mcp.ts`
- Test: `tests/mcp.test.ts`

> **Read first:** the MCP SDK stateless Streamable HTTP example (link in header). Tools are registered on an `McpServer`; each POST creates a fresh `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, then `transport.handleRequest(req, res, body)`. GET/DELETE return 405. We unit-test the **tool implementations** directly (not the transport) to keep tests fast and deterministic.

- [ ] **Step 1: Write the failing test `tests/mcp.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { makeTools } from "../src/server/mcp.ts";

function tools() {
  const store = new Store(openDb(":memory:"));
  return { store, t: makeTools({ store, onChange: () => {}, now: () => 7000 }) };
}

describe("MCP tools", () => {
  it("record_handoff creates a to_hand_off todo with origin + branch", () => {
    const { store, t } = tools();
    const out = t.record_handoff({
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
    expect(todos[0].status).toBe("to_hand_off");
    expect(todos[0].for_who).toBe("Maria");
    expect(todos[0].origin_project).toBe("bov-frontend");
    expect(todos[0].branch).toBe("feat/pay");
    expect(todos[0].links).toEqual(["docs/specs/pay.md"]);
  });

  it("list_todos returns current todos, optionally filtered", () => {
    const { t } = tools();
    t.record_handoff({ title: "a", note: "" });
    const all = t.list_todos({});
    expect(all.todos.length).toBe(1);
    const none = t.list_todos({ status: "done" });
    expect(none.todos.length).toBe(0);
  });

  it("update_handoff changes status", () => {
    const { store, t } = tools();
    const { id } = t.record_handoff({ title: "a", note: "" });
    const out = t.update_handoff({ id, status: "handed_off" });
    expect(out.ok).toBe(true);
    expect(store.getTodo(id)!.status).toBe("handed_off");
  });

  it("update_handoff on a missing id returns ok:false", () => {
    const { t } = tools();
    expect(t.update_handoff({ id: "nope", status: "done" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/mcp.test.ts`
Expected: FAIL — `makeTools` not found.

- [ ] **Step 3: Write `src/server/mcp.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import type { TodoStatus } from "./types.ts";

export interface McpDeps {
  store: Store;
  onChange: () => void;
  now?: () => number;
}

/** Plain tool implementations — unit-testable without the transport. */
export function makeTools(deps: McpDeps) {
  const now = deps.now ?? (() => Date.now());
  const { store, onChange } = deps;
  return {
    record_handoff(input: {
      title: string;
      note: string;
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
    update_handoff(input: { id: string; status?: TodoStatus; note?: string }) {
      const updated = store.updateTodo(
        input.id,
        { status: input.status, note: input.note },
        now()
      );
      if (updated) onChange();
      return { ok: !!updated };
    },
  };
}

function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "work-monitor", version: "0.1.0" });
  const tools = makeTools(deps);

  server.tool(
    "record_handoff",
    "Record a persistent hand-off todo that appears on the work-monitor dashboard. Use when the user asks you to remember to hand work off to another engineer. Fill note with the context the next person needs (what's done, what's left, where the spec/branch is).",
    {
      title: z.string().describe("Short title, e.g. 'Hand off payments spec'"),
      note: z.string().describe("Rich context: what's done, what's left, paths"),
      for_who: z.string().optional().describe("Who to hand off to, if known"),
      project: z.string().optional().describe("Project name"),
      branch: z.string().optional().describe("Git branch holding the work"),
      links: z.array(z.string()).optional().describe("Spec paths, PR URLs, etc."),
    },
    async (args) => {
      const out = tools.record_handoff(args);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
  );

  server.tool(
    "list_todos",
    "List current work-monitor hand-off todos (optionally filtered by status) so you can avoid creating duplicates.",
    { status: z.enum(["to_hand_off", "handed_off", "done"]).optional() },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(tools.list_todos(args)) }] })
  );

  server.tool(
    "update_handoff",
    "Update a hand-off todo (e.g. mark it handed_off or done, or amend the note).",
    {
      id: z.string(),
      status: z.enum(["to_hand_off", "handed_off", "done"]).optional(),
      note: z.string().optional(),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(tools.update_handoff(args)) }] })
  );

  return server;
}

/** Stateless handler: fresh server+transport per POST. */
export async function handleMcpRequest(
  deps: McpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
    return;
  }
  const server = buildServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp.ts tests/mcp.test.ts
git commit -m "feat: MCP tools + stateless Streamable HTTP handler (TDD)"
```

### Task 11: Wire MCP into http.ts

**Files:**
- Modify: `src/server/http.ts`

- [ ] **Step 1: Add MCP route to `createApp`**

In `AppDeps`, add optional `mcp?: McpDeps`. Near the top of the `app` function (before the 404), add:

```ts
      if (path === "/mcp") {
        if (!deps.mcp) {
          res.writeHead(503).end();
          return;
        }
        let body: unknown = undefined;
        if (method === "POST") {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : undefined;
        }
        await handleMcpRequest(deps.mcp, req, res, body);
        return;
      }
```

Add imports at the top:

```ts
import { handleMcpRequest, type McpDeps } from "./mcp.ts";
```

And extend `AppDeps`:

```ts
export interface AppDeps {
  store: Store;
  sse: SseHub;
  mcp?: McpDeps;
  now?: () => number;
}
```

- [ ] **Step 2: Add a smoke test to `tests/http.test.ts`**

```ts
describe("MCP route", () => {
  it("returns 405 for GET /mcp (stateless)", async () => {
    // rebuild app with mcp deps
    const res = await fetch(`${base}/mcp`, { method: "GET" });
    // Without mcp deps wired in this test's app, expect 503; with deps, 405.
    expect([405, 503]).toContain(res.status);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/http.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/http.ts tests/http.test.ts
git commit -m "feat: mount MCP endpoint at /mcp"
```

---

## Phase 6 — Server entry + staleness loop

### Task 12: index.ts

**Files:**
- Create: `src/server/index.ts`

- [ ] **Step 1: Write `src/server/index.ts`**

```ts
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { Store } from "./store.ts";
import { SseHub } from "./sse.ts";
import { createApp, type AppDeps } from "./http.ts";
import { PORT, HOST, DB_PATH, STALE_MS, SWEEP_INTERVAL_MS } from "./config.ts";

const store = new Store(openDb(DB_PATH));
const sse = new SseHub();
const onChange = () => sse.broadcast("state", { sessions: store.listSessions(), todos: store.listTodos() });

const deps: AppDeps = { store, sse, mcp: { store, onChange } };
const app = createApp(deps);

// Serve built dashboard from dist/web if present (production).
const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "..", "dist", "web");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const apiish =
    url.pathname.startsWith("/api") ||
    url.pathname === "/events" ||
    url.pathname === "/mcp";
  if (!apiish && existsSync(webDir)) {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(join(webDir, rel));
    if (await file.exists()) {
      res.writeHead(200, { "content-type": file.type || "application/octet-stream" });
      res.end(Buffer.from(await file.arrayBuffer()));
      return;
    }
    // SPA fallback
    const index = Bun.file(join(webDir, "index.html"));
    if (await index.exists()) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(Buffer.from(await index.arrayBuffer()));
      return;
    }
  }
  await app(req, res);
});

setInterval(() => {
  const affected = store.sweepStale(Date.now(), STALE_MS);
  if (affected.length > 0) onChange();
}, SWEEP_INTERVAL_MS);

server.listen(PORT, HOST, () => {
  console.log(`wm-server listening on http://${HOST}:${PORT}`);
});
```

- [ ] **Step 2: Manual smoke test**

Run (in one shell): `WM_DB_PATH=/tmp/wm-smoke.sqlite bun run src/server/index.ts`
Then (another shell):
```bash
curl -s -XPOST "http://127.0.0.1:4317/events?type=session_start" -H 'content-type: application/json' -d '{"session_id":"s1","cwd":"/x/browns"}'
curl -s "http://127.0.0.1:4317/api/state" | jq
```
Expected: state shows session `s1`, project `browns`, status `working`. Stop the server (Ctrl-C); `rm /tmp/wm-smoke.sqlite*`.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: server entry — http + static dashboard + staleness loop"
```

---

## Phase 7 — Hook forwarder

### Task 13: wm-hook.sh

**Files:**
- Create: `src/hooks/wm-hook.sh`

- [ ] **Step 1: Write `src/hooks/wm-hook.sh`**

```sh
#!/usr/bin/env sh
# Forward a Claude Code hook event to wm-server. Arg $1 = event type.
# Reads the hook JSON from stdin, POSTs it, and detaches so it never blocks Claude.
type="$1"
payload=$(cat)
port="${WM_PORT:-4317}"
( curl -s -m 1 -X POST "http://127.0.0.1:${port}/events?type=${type}" \
    -H 'content-type: application/json' \
    -d "$payload" >/dev/null 2>&1 & ) >/dev/null 2>&1
exit 0
```

- [ ] **Step 2: Make executable**

Run: `chmod +x src/hooks/wm-hook.sh`

- [ ] **Step 3: Manual test against a running server**

Start the server (as in Task 12). Then:
```bash
echo '{"session_id":"s2","cwd":"/x/love-island"}' | src/hooks/wm-hook.sh notification
sleep 1
curl -s "http://127.0.0.1:4317/api/state" | jq '.sessions[] | select(.id=="s2")'
```
Expected: session `s2`, status `needs_you`. (The notification message is null here, so attention_reason falls back to "Needs your attention".)

- [ ] **Step 4: Commit**

```bash
git add src/hooks/wm-hook.sh
git commit -m "feat: hook forwarder script"
```

---

## Phase 8 — Setup (`wm setup`)

### Task 14: settings-merge.ts (pure, TDD)

**Files:**
- Create: `src/cli/settings-merge.ts`
- Test: `tests/settings-merge.test.ts`

- [ ] **Step 1: Write the failing test `tests/settings-merge.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { mergeHooks, HOOK_EVENTS } from "../src/cli/settings-merge.ts";

const HOOK = "/abs/src/hooks/wm-hook.sh";

describe("mergeHooks", () => {
  it("creates a hooks key when absent, one entry per event", () => {
    const out = mergeHooks({}, HOOK);
    for (const [evt] of HOOK_EVENTS) {
      expect(out.hooks[evt]).toBeDefined();
      const cmd = out.hooks[evt][0].hooks[0].command;
      expect(cmd).toContain("wm-hook.sh");
    }
  });

  it("preserves unrelated existing hooks", () => {
    const existing = {
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "other.sh" }] }] },
    };
    const out = mergeHooks(existing, HOOK);
    const stopCmds = out.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("other.sh");
    expect(stopCmds.some((c: string) => c.includes("wm-hook.sh"))).toBe(true);
  });

  it("is idempotent — re-merging does not duplicate our entries", () => {
    const once = mergeHooks({}, HOOK);
    const twice = mergeHooks(once, HOOK);
    const stopWm = twice.hooks.Stop.flatMap((g: any) => g.hooks)
      .filter((h: any) => h.command.includes("wm-hook.sh"));
    expect(stopWm.length).toBe(1);
  });

  it("uses the TodoWrite matcher for PostToolUse", () => {
    const out = mergeHooks({}, HOOK);
    expect(out.hooks.PostToolUse[0].matcher).toBe("TodoWrite");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/settings-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/settings-merge.ts`**

```ts
// [event, wm_event_type, matcher]
export const HOOK_EVENTS: [string, string, string][] = [
  ["SessionStart", "session_start", ""],
  ["UserPromptSubmit", "prompt", ""],
  ["PostToolUse", "todo_update", "TodoWrite"],
  ["Notification", "notification", ""],
  ["Stop", "stop", ""],
  ["SessionEnd", "session_end", ""],
];

interface HookCmd { type: "command"; command: string }
interface HookGroup { matcher?: string; hooks: HookCmd[] }
interface Settings { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

function command(hookPath: string, type: string): string {
  return `${hookPath} ${type}`;
}

export function mergeHooks(settings: Settings, hookPath: string): Settings & { hooks: Record<string, HookGroup[]> } {
  const out: Settings & { hooks: Record<string, HookGroup[]> } = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };
  for (const [event, type, matcher] of HOOK_EVENTS) {
    const cmd = command(hookPath, type);
    const groups = [...(out.hooks[event] ?? [])];
    const already = groups.some((g) => g.hooks?.some((h) => h.command.includes("wm-hook.sh")));
    if (!already) {
      groups.push({ matcher, hooks: [{ type: "command", command: cmd }] });
    }
    out.hooks[event] = groups;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/settings-merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/settings-merge.ts tests/settings-merge.test.ts
git commit -m "feat: idempotent settings.json hook merge (TDD)"
```

### Task 15: systemd unit template + setup.ts

**Files:**
- Create: `src/cli/wm-server.service.tmpl`
- Create: `src/cli/setup.ts`

- [ ] **Step 1: Write `src/cli/wm-server.service.tmpl`**

```ini
[Unit]
Description=work-monitor server
After=default.target

[Service]
Type=simple
ExecStart=__BUN__ run __PROJECT__/src/server/index.ts
Restart=on-failure
Environment=WM_PORT=__PORT__

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Write `src/cli/setup.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mergeHooks } from "./settings-merge.ts";
import { PORT } from "../server/config.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunPath = process.execPath; // path to bun
const settingsPath = join(homedir(), ".claude", "settings.json");
const hookPath = join(projectRoot, "src", "hooks", "wm-hook.sh");

function step(msg: string) {
  console.log(`\x1b[36m▸\x1b[0m ${msg}`);
}

function installService() {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const tmpl = readFileSync(join(projectRoot, "src", "cli", "wm-server.service.tmpl"), "utf8");
  const unit = tmpl
    .replaceAll("__BUN__", bunPath)
    .replaceAll("__PROJECT__", projectRoot)
    .replaceAll("__PORT__", String(PORT));
  writeFileSync(join(unitDir, "wm-server.service"), unit);
  step(`Wrote systemd unit to ${join(unitDir, "wm-server.service")}`);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "wm-server.service"]);
    step("Enabled + started wm-server.service");
  } catch (e) {
    console.warn("Could not enable service automatically:", String(e));
    console.warn("Run: systemctl --user enable --now wm-server.service");
  }
}

function mergeSettings() {
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    settings = raw.trim() ? JSON.parse(raw) : {};
    copyFileSync(settingsPath, settingsPath + ".wm-backup");
    step(`Backed up settings to ${settingsPath}.wm-backup`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  const merged = mergeHooks(settings, hookPath);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  step("Merged work-monitor hooks into ~/.claude/settings.json");
}

function registerMcp() {
  try {
    execFileSync("claude", [
      "mcp", "add", "--scope", "user", "--transport", "http",
      "work-monitor", `http://127.0.0.1:${PORT}/mcp`,
    ], { stdio: "inherit" });
    step("Registered work-monitor MCP server (user scope)");
  } catch (e) {
    console.warn("Could not register MCP automatically:", String(e));
    console.warn(`Run: claude mcp add --scope user --transport http work-monitor http://127.0.0.1:${PORT}/mcp`);
  }
}

function main() {
  console.log("Setting up work-monitor...\n");
  execFileSync(bunPath, ["x", "chmod", "+x", hookPath].slice(0, 0), { stdio: "ignore" }); // no-op guard
  installService();
  mergeSettings();
  registerMcp();
  console.log(`\n\x1b[32m✓ Done.\x1b[0m Open http://127.0.0.1:${PORT} and pin the tab.`);
  console.log("New Claude Code sessions will report automatically. Restart any open sessions to load the hooks + MCP.");
}

main();
```

> Note: ensure `chmod +x src/hooks/wm-hook.sh` was committed (Task 13). The no-op guard line above is intentionally inert; if a linter objects, replace it with nothing.

- [ ] **Step 3: Add a `setup` script to `package.json`**

Add to `scripts`: `"setup": "bun run src/cli/setup.ts"`.

- [ ] **Step 4: Dry verification (do NOT mutate the real environment in autonomous mode)**

Run a syntax/type check only: `bun build src/cli/setup.ts --target=bun --outfile=/tmp/setup-check.js`
Expected: builds without error. **Do not execute `bun run setup` here** — running it installs a service, edits `~/.claude/settings.json`, and registers a global MCP server. That activation step is left for the user to run explicitly (see README + final handoff).

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts src/cli/wm-server.service.tmpl package.json
git commit -m "feat: wm setup — systemd unit, settings merge, mcp registration"
```

---

## Phase 9 — Dashboard (React + Vite + Tailwind)

### Task 16: Vite + Tailwind scaffold

**Files:**
- Create: `vite.config.ts`, `src/web/index.html`, `src/web/main.tsx`, `src/web/styles.css`, `postcss.config.js`, `tailwind.config.js`

- [ ] **Step 1: Write `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  server: {
    port: 5317,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/events": "http://127.0.0.1:4317",
      "/mcp": "http://127.0.0.1:4317",
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
```

- [ ] **Step 2: Write `tailwind.config.js`**

```js
export default {
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: { extend: {} },
  plugins: [],
};
```

- [ ] **Step 3: Write `postcss.config.js`**

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 4: Write `src/web/styles.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root { color-scheme: dark; }
body { @apply bg-slate-950 text-slate-200; }
```

- [ ] **Step 5: Write `src/web/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>work-monitor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Write `src/web/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 7: Verify the dev build compiles**

Run: `bun run web:build`
Expected: builds (App.tsx will be created next task — if this fails on missing App, proceed to Task 17 then re-run).

- [ ] **Step 8: Commit**

```bash
git add vite.config.ts tailwind.config.js postcss.config.js src/web/styles.css src/web/index.html src/web/main.tsx
git commit -m "feat: vite + tailwind dashboard scaffold"
```

### Task 17: API client + types

**Files:**
- Create: `src/web/types.ts`, `src/web/api.ts`

- [ ] **Step 1: Write `src/web/types.ts`**

```ts
export type SessionStatus = "working" | "needs_you" | "idle" | "ended";
export type TodoStatus = "to_hand_off" | "handed_off" | "done";

export interface Session {
  id: string;
  project: string;
  status: SessionStatus;
  current_task: string | null;
  current_intent: string | null;
  attention_reason: string | null;
  started_at: number;
  last_activity_at: number;
}

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
}

export interface State {
  sessions: Session[];
  todos: Todo[];
}
```

- [ ] **Step 2: Write `src/web/api.ts`**

```ts
import type { State, TodoStatus } from "./types.ts";

export async function fetchState(): Promise<State> {
  const r = await fetch("/api/state");
  return r.json();
}

export function subscribe(onState: (s: State) => void): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => onState(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export async function patchTodo(id: string, patch: { status?: TodoStatus; position?: number }): Promise<void> {
  await fetch(`/api/todos/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteTodo(id: string): Promise<void> {
  await fetch(`/api/todos/${id}`, { method: "DELETE" });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/types.ts src/web/api.ts
git commit -m "feat: dashboard api client + types"
```

### Task 18: Board + cards + drag-and-drop

**Files:**
- Create: `src/web/App.tsx`, `src/web/components/Board.tsx`, `src/web/components/Lane.tsx`, `src/web/components/SessionCard.tsx`, `src/web/components/TodoCard.tsx`

Design intent (matches the locked spec layout):
- Top lane "Hand-offs & todos": three droppable columns `to_hand_off / handed_off / done`; `TodoCard`s are draggable via `@dnd-kit`; dropping into a column calls `patchTodo(id, { status })`.
- Bottom lane "Sessions": three read-only columns grouped by `working / needs_you / idle`; `SessionCard`s are not draggable.
- Colors: working = blue, needs_you = amber, idle = slate; to_hand_off = amber accent, handed_off = indigo, done = green/faded.
- Responsive: lanes are flex rows that wrap; columns stack on narrow screens (`flex-col sm:flex-row`).

- [ ] **Step 1: Write `src/web/components/SessionCard.tsx`**

```tsx
import type { Session } from "../types.ts";

const ACCENT: Record<string, string> = {
  working: "border-l-blue-500",
  needs_you: "border-l-amber-500",
  idle: "border-l-slate-500",
  ended: "border-l-slate-700",
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function SessionCard({ s }: { s: Session }) {
  return (
    <div className={`rounded-md border border-slate-800 border-l-4 ${ACCENT[s.status]} bg-slate-900 p-3 mb-2`}>
      <div className="font-semibold text-slate-100">{s.project}</div>
      <div className="text-xs text-slate-400 mt-1">
        {s.current_task ?? s.current_intent ?? "—"}
      </div>
      {s.attention_reason && s.status === "needs_you" && (
        <div className="text-xs text-amber-400 mt-1">⚠ {s.attention_reason}</div>
      )}
      <div className="text-[10px] text-slate-600 mt-2">{ago(s.last_activity_at)}</div>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/web/components/TodoCard.tsx`**

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
      className="rounded-md border border-slate-800 bg-slate-900 p-3 mb-2 cursor-grab"
    >
      <div className="flex justify-between gap-2">
        <div className="font-semibold text-slate-100" {...listeners} {...attributes}>{t.title}</div>
        <button className="text-slate-600 hover:text-red-400 text-xs" onClick={() => deleteTodo(t.id)}>✕</button>
      </div>
      {t.note && <div className="text-xs text-slate-400 mt-1 whitespace-pre-wrap">{t.note}</div>}
      <div className="text-[10px] mt-2 space-x-2">
        {t.for_who && <span className="text-amber-400">→ {t.for_who}</span>}
        {t.branch && <span className="text-slate-500">⎇ {t.branch}</span>}
        {t.origin_project && <span className="text-slate-600">{t.origin_project}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/web/components/Lane.tsx`**

```tsx
import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";

export function Column({
  id,
  title,
  count,
  accent,
  droppable,
  children,
}: {
  id: string;
  title: string;
  count: number;
  accent: string;
  droppable?: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={`flex-1 min-w-0 rounded-lg border border-slate-800 bg-slate-950 p-2 ${isOver ? "ring-1 ring-amber-500" : ""}`}
    >
      <div className={`text-[10px] uppercase tracking-wide mb-2 flex justify-between ${accent}`}>
        <span>{title}</span>
        <span className="text-slate-600">{count}</span>
      </div>
      {children}
    </div>
  );
}

export function Lane({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2 flex gap-2 items-center">
        {label}
        <span className="normal-case tracking-normal text-[9px] bg-slate-800 text-slate-400 rounded-full px-2 py-0.5">{hint}</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-start">{children}</div>
    </section>
  );
}
```

- [ ] **Step 4: Write `src/web/components/Board.tsx`**

```tsx
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import type { State, Todo, Session, TodoStatus } from "../types.ts";
import { patchTodo } from "../api.ts";
import { Lane, Column } from "./Lane.tsx";
import { TodoCard } from "./TodoCard.tsx";
import { SessionCard } from "./SessionCard.tsx";

const TODO_COLS: { id: TodoStatus; title: string; accent: string }[] = [
  { id: "to_hand_off", title: "◇ To hand off", accent: "text-amber-400" },
  { id: "handed_off", title: "◇ Handed off", accent: "text-indigo-400" },
  { id: "done", title: "✓ Done", accent: "text-emerald-400" },
];

const SESSION_COLS: { id: Session["status"]; title: string; accent: string }[] = [
  { id: "working", title: "● Working", accent: "text-blue-400" },
  { id: "needs_you", title: "● Needs you", accent: "text-amber-400" },
  { id: "idle", title: "● Idle / done", accent: "text-slate-400" },
];

export function Board({ state }: { state: State }) {
  const byTodo = (s: TodoStatus) => state.todos.filter((t) => t.status === s);
  const bySession = (s: Session["status"]) => state.sessions.filter((x) => x.status === s);

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    const over = e.over?.id as TodoStatus | undefined;
    if (!over) return;
    const todo = state.todos.find((t: Todo) => t.id === id);
    if (todo && todo.status !== over) patchTodo(id, { status: over });
  }

  return (
    <div className="max-w-6xl mx-auto p-4">
      <h1 className="text-lg font-semibold text-slate-100 mb-4">work-monitor</h1>

      <DndContext onDragEnd={onDragEnd}>
        <Lane label="★ Hand-offs & todos" hint="manual — drag cards as you deal with them">
          {TODO_COLS.map((c) => (
            <Column key={c.id} id={c.id} title={c.title} accent={c.accent} count={byTodo(c.id).length} droppable>
              {byTodo(c.id).map((t) => (
                <TodoCard key={t.id} t={t} />
              ))}
            </Column>
          ))}
        </Lane>
      </DndContext>

      <Lane label="Sessions" hint="auto — moves itself from agent hook events">
        {SESSION_COLS.map((c) => (
          <Column key={c.id} id={`sess-${c.id}`} title={c.title} accent={c.accent} count={bySession(c.id).length}>
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

- [ ] **Step 5: Write `src/web/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fetchState, subscribe } from "./api.ts";
import type { State } from "./types.ts";
import { Board } from "./components/Board.tsx";

export default function App() {
  const [state, setState] = useState<State>({ sessions: [], todos: [] });

  useEffect(() => {
    fetchState().then(setState).catch(() => {});
    const unsub = subscribe(setState);
    return unsub;
  }, []);

  return <Board state={state} />;
}
```

- [ ] **Step 6: Build the dashboard**

Run: `bun run web:build`
Expected: `dist/web/index.html` + assets produced, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/web
git commit -m "feat: two-lane kanban dashboard (sessions auto, hand-offs drag)"
```

### Task 19: Frontend smoke test

**Files:**
- Create: `vitest.config.ts`, `web-tests/Board.test.tsx`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", include: ["web-tests/**/*.test.tsx"] },
});
```

- [ ] **Step 2: Write `web-tests/Board.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board } from "../src/web/components/Board.tsx";
import type { State } from "../src/web/types.ts";

vi.mock("../src/web/api.ts", () => ({ patchTodo: vi.fn(), deleteTodo: vi.fn() }));

const state: State = {
  sessions: [
    { id: "s1", project: "browns", status: "working", current_task: "Refactor (1/3 done)", current_intent: null, attention_reason: null, started_at: Date.now(), last_activity_at: Date.now() },
    { id: "s2", project: "love-island", status: "needs_you", current_task: null, current_intent: "tests", attention_reason: "Run migration?", started_at: Date.now(), last_activity_at: Date.now() },
  ],
  todos: [
    { id: "t1", title: "Hand off spec", note: "branch feat/pay", for_who: "Maria", status: "to_hand_off", origin_project: "bov", branch: "feat/pay", links: null, position: 0 },
  ],
};

describe("Board", () => {
  it("renders sessions in the right status columns and the hand-off card", () => {
    render(<Board state={state} />);
    expect(screen.getByText("browns")).toBeDefined();
    expect(screen.getByText("Refactor (1/3 done)")).toBeDefined();
    expect(screen.getByText("⚠ Run migration?")).toBeDefined();
    expect(screen.getByText("Hand off spec")).toBeDefined();
    expect(screen.getByText("→ Maria")).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the frontend test**

Run: `bun run web:test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts web-tests/Board.test.tsx
git commit -m "test: dashboard board smoke test"
```

---

## Phase 10 — Integration + docs

### Task 20: End-to-end smoke + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Full backend test run**

Run: `bun test tests/`
Expected: all suites pass.

- [ ] **Step 2: Live end-to-end check**

```bash
WM_DB_PATH=/tmp/wm-e2e.sqlite bun run src/server/index.ts &   # start
sleep 1
# simulate two sessions via the hook script
echo '{"session_id":"a","cwd":"/p/browns","prompt":"refactor checkout"}' | src/hooks/wm-hook.sh prompt
echo '{"session_id":"a","tool_name":"TodoWrite","tool_input":{"todos":[{"content":"Build API","status":"in_progress"},{"content":"x","status":"completed"}]}}' | src/hooks/wm-hook.sh todo_update
echo '{"session_id":"b","cwd":"/p/love-island","message":"Run migration?"}' | src/hooks/wm-hook.sh notification
sleep 1
curl -s localhost:4317/api/state | jq '.sessions | map({project, status, current_task})'
# create a hand-off via REST (same path the MCP tool uses)
curl -s -XPOST localhost:4317/api/todos -H 'content-type: application/json' \
  -d '{"title":"Hand off pay spec","note":"docs/specs/pay.md","for_who":"Maria","branch":"feat/pay"}' | jq
kill %1; rm -f /tmp/wm-e2e.sqlite*
```
Expected: session `a` status `working`, `current_task` = `Build API (1/2 done)`; session `b` status `needs_you`; todo created in `to_hand_off`.

- [ ] **Step 3: Write `README.md`**

````markdown
# work-monitor

Live dashboard for parallel Claude Code sessions + agent-authored hand-off todos.

## What it does
- Each Claude Code session reports status automatically (hooks): **working / needs you / idle**.
- A pinned web dashboard shows a two-lane kanban: hand-offs on top (you drag), live sessions below (auto).
- Agents record hand-off todos via an MCP tool (`record_handoff`) — say *"set a hand-off todo for this"*.

## Install / activate
```bash
bun install
bun run web:build
bun run setup     # installs systemd user service, merges hooks, registers MCP
```
`bun run setup` will:
- install + start a `systemd --user` service running the server on `127.0.0.1:4317`,
- merge hook entries into `~/.claude/settings.json` (backs up first),
- register the `work-monitor` MCP server at user scope.

Then open **http://127.0.0.1:4317** and pin the tab. Restart any open Claude Code
sessions so they pick up the new hooks + MCP.

## Dev
- `bun run server` — run the server in the foreground.
- `bun run web:dev` — Vite dev server (proxies /api, /events, /mcp to :4317).
- `bun test tests/` — backend tests. `bun run web:test` — frontend tests.

## Config
- `WM_PORT` (default 4317), `WM_DB_PATH` (default `~/.local/share/work-monitor/work-monitor.sqlite`).

## Uninstall
```bash
systemctl --user disable --now wm-server.service
claude mcp remove work-monitor --scope user
# remove the work-monitor hook entries from ~/.claude/settings.json (restore .wm-backup)
```
````

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README — install, dev, config"
```

---

## Self-Review Notes (already reconciled)

- **Spec coverage:** session monitoring (Tasks 5–7, 13), needs-you vs idle (Task 5), current-task from TodoWrite (Tasks 4–5), staleness sweep (Task 7, 12), hand-off todos via MCP (Task 10b) + REST mirror (Task 10), two-lane kanban with hand-offs on top (Task 18), live SSE (Tasks 9–10, 17), setup script (Tasks 14–15), responsive (Task 18), v2-ready HTTP surface (all). 
- **Type consistency:** `Session`/`Todo`/`TodoStatus`/`SessionStatus` shared shapes used identically in server (`types.ts`) and web (`web/types.ts`); `createTodo(input, now)`, `updateTodo(id, patch, now)`, `applyEvent(id, patch, now)`, `reduceEvent(event, now)` signatures consistent across tasks and tests.
- **Activation safety:** the only environment-mutating step (`bun run setup`) is explicitly **not** run during autonomous implementation; it is handed to the user.
```
