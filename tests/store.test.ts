import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, migrate } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { reduceEvent } from "../src/server/events.ts";
import { randomUUID } from "node:crypto";

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

  const STALE = 10 * 60 * 1000;
  const DEAD = 30 * 60 * 1000;
  const NEEDS_YOU_DEAD = 24 * 60 * 60 * 1000;

  it("sweepStale moves quiet working sessions (stale < silence < dead) to idle, tagged 'quiet'", () => {
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch, 1000);
    const affected = store.sweepStale(1000 + 11 * 60 * 1000, STALE, DEAD, NEEDS_YOU_DEAD);
    expect(affected).toContain("s1");
    expect(store.getSession("s1")!.status).toBe("idle");
    expect(store.getSession("s1")!.idle_reason).toBe("quiet");
  });

  it("sweepStale retires long-silent working/idle sessions to ended (hidden from the board)", () => {
    store.applyEvent("w", reduceEvent({ wm_event_type: "session_start", session_id: "w", cwd: "/x/b" }, 1000).patch, 1000);
    store.applyEvent("i", reduceEvent({ wm_event_type: "session_start", session_id: "i", cwd: "/x/b" }, 1000).patch, 1000);
    store.applyEvent("i", reduceEvent({ wm_event_type: "stop", session_id: "i" }, 1000).patch, 1000);

    const now = 1000 + 31 * 60 * 1000;
    const affected = store.sweepStale(now, STALE, DEAD, NEEDS_YOU_DEAD);
    expect(affected).toEqual(expect.arrayContaining(["w", "i"]));
    for (const id of ["w", "i"]) {
      expect(store.getSession(id)!.status).toBe("ended");
      expect(store.getSession(id)!.ended_at).toBe(now);
    }
    expect(store.listSessions().length).toBe(0);
  });

  it("sweepStale exempts needs_you sessions from the ordinary dead sweep (§1.6)", () => {
    store.applyEvent("n", reduceEvent({ wm_event_type: "session_start", session_id: "n", cwd: "/x/b" }, 1000).patch, 1000);
    store.applyEvent("n", reduceEvent({ wm_event_type: "notification", session_id: "n", message: "needs you" }, 1000).patch, 1000);

    // Well past the ordinary 30-minute dead threshold, but nowhere near 24h.
    const now = 1000 + 31 * 60 * 1000;
    const affected = store.sweepStale(now, STALE, DEAD, NEEDS_YOU_DEAD);
    expect(affected).not.toContain("n");
    expect(store.getSession("n")!.status).toBe("needs_you");

    // Only the much longer needs_you grace period retires it.
    const muchLater = 1000 + 25 * 60 * 60 * 1000;
    const affectedLater = store.sweepStale(muchLater, STALE, DEAD, NEEDS_YOU_DEAD);
    expect(affectedLater).toContain("n");
    expect(store.getSession("n")!.status).toBe("ended");
  });

  it("sweepStale leaves recently-active sessions untouched", () => {
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch, 1000);
    const affected = store.sweepStale(1000 + 5 * 60 * 1000, STALE, DEAD, NEEDS_YOU_DEAD);
    expect(affected).toEqual([]);
    expect(store.getSession("s1")!.status).toBe("working");
  });

  it("stores and updates the session branch", () => {
    store.applyEvent("s1", { project: "p", cwd: "/x", status: "working", last_activity_at: 1000 }, 1000);
    expect(store.getSession("s1")!.branch).toBeNull();
    store.applyEvent("s1", { branch: "feat/x", last_activity_at: 2000 }, 2000);
    expect(store.getSession("s1")!.branch).toBe("feat/x");
  });

  it("preserves current_intent through the store when a later prompt is a synthetic task-notification", () => {
    store.applyEvent(
      "s1",
      reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch,
      1000
    );
    store.applyEvent(
      "s1",
      reduceEvent({ wm_event_type: "prompt", session_id: "s1", prompt: "Refactor checkout" }, 2000).patch,
      2000
    );
    expect(store.getSession("s1")!.current_intent).toBe("Refactor checkout");

    store.applyEvent(
      "s1",
      reduceEvent(
        {
          wm_event_type: "prompt",
          session_id: "s1",
          prompt: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>",
        },
        3000
      ).patch,
      3000
    );
    expect(store.getSession("s1")!.current_intent).toBe("Refactor checkout");
  });

  it("idempotently adds the sessions.branch column to a pre-existing table", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const has = () => (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).filter((c) => c.name === "branch").length;
    expect(has()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has()).toBe(1);
  });

  it("idempotently creates the usage table and sessions.usage_offset column", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const hasTable = () =>
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'").all() as unknown[]).length;
    const hasOffset = () =>
      (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).filter((c) => c.name === "usage_offset").length;
    expect(hasTable()).toBe(1);
    expect(hasOffset()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(hasTable()).toBe(1);
    expect(hasOffset()).toBe(1);
  });

  it("idempotently adds usage.project and usage.branch to a pre-existing usage table", () => {
    const db = new Database(":memory:");
    // A usage table predating the project/branch columns (token columns have
    // existed since the very first schema and are part of the rebuild's
    // baseline column set -- see the cost_usd-nullable rebuild below).
    db.exec(`CREATE TABLE usage (message_uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL, at INTEGER NOT NULL);`);
    migrate(db);
    const has = (col: string) =>
      (db.query("PRAGMA table_info(usage)").all() as { name: string }[]).filter((c) => c.name === col).length;
    expect(has("project")).toBe(1);
    expect(has("branch")).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has("project")).toBe(1);
    expect(has("branch")).toBe(1);
  });

  it("rebuilds usage.cost_usd as nullable (§2.3), preserving rows, columns and indexes", () => {
    const db = new Database(":memory:");
    // A usage table from before cost_usd could be NULL (and before message_key/harness).
    db.exec(`CREATE TABLE usage (message_uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL, project TEXT, branch TEXT,
      at INTEGER NOT NULL, run_id TEXT, agent_id TEXT);
      CREATE INDEX idx_usage_session ON usage(session_id);`);
    db.query(
      `INSERT INTO usage (message_uuid, session_id, model, input_tokens, output_tokens, cache_read_tokens,
        cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at, run_id, agent_id)
       VALUES ('u1','s1','claude-opus-5',100,20,0,0,0,1.23,'alpha','main',1000,NULL,NULL)`
    ).run();
    migrate(db);
    const col = (db.query("PRAGMA table_info(usage)").all() as { name: string; notnull: number }[]).find(
      (c) => c.name === "cost_usd"
    )!;
    expect(col.notnull).toBe(0);
    expect(db.query("SELECT * FROM usage WHERE message_uuid = 'u1'").get()).toEqual({
      message_uuid: "u1", message_key: null, session_id: "s1", model: "claude-opus-5",
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_create_5m_tokens: 0,
      cache_create_1h_tokens: 0, cost_usd: 1.23, project: "alpha", branch: "main", at: 1000,
      run_id: null, agent_id: null, harness: null,
    });
    // A fresh row with a NULL cost must now be writable at all (the point of this rebuild).
    db.query(
      `INSERT INTO usage (message_uuid, session_id, model, at, cost_usd) VALUES ('u2','s1','gpt-9',1000,NULL)`
    ).run();
    expect((db.query("SELECT cost_usd FROM usage WHERE message_uuid = 'u2'").get() as { cost_usd: null }).cost_usd).toBeNull();
    // Indexes survive the rebuild (idx_usage_session existed before; the rest are always recreated).
    const indexNames = (db.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage'`).all() as { name: string }[]).map((r) => r.name);
    expect(indexNames).toContain("idx_usage_session");
    expect(indexNames).toContain("idx_usage_at");
    expect(indexNames).toContain("idx_usage_message_key");
    migrate(db); // idempotent: no crash, no data loss, no second rebuild attempt
    expect(db.query("SELECT COUNT(*) AS c FROM usage").get()).toEqual({ c: 2 });
  });

  it("round-trips app_meta values and overwrites on repeat set", () => {
    expect(store.getMeta("nope")).toBeNull();
    store.setMeta("marker", "123");
    expect(store.getMeta("marker")).toBe("123");
    store.setMeta("marker", "456");
    expect(store.getMeta("marker")).toBe("456");
  });

  it("idempotently creates the subagents table (§2.4)", () => {
    const db = new Database(":memory:");
    migrate(db);
    const hasTable = () =>
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='subagents'").all() as unknown[]).length;
    expect(hasTable()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(hasTable()).toBe(1);
  });

  it("idempotently creates app_meta on a pre-existing DB", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const has = () =>
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").all() as unknown[]).length;
    expect(has()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has()).toBe(1);
  });

  it("idempotently creates workflow_runs and workflow_agents on a pre-existing DB", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const hasTable = (n: string) =>
      (db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='${n}'`).all() as unknown[]).length;
    expect(hasTable("workflow_runs")).toBe(1);
    expect(hasTable("workflow_agents")).toBe(1);
    // manifest_mtime is what makes an in-place manifest rewrite (C6) re-parse;
    // the run dir's mtime never moves for it, so nothing else would notice.
    const runCols = (db.query("PRAGMA table_info(workflow_runs)").all() as { name: string }[]).map((c) => c.name);
    expect(runCols).toContain("manifest_mtime");
    migrate(db); // second run must not throw or duplicate
    expect(hasTable("workflow_runs")).toBe(1);
    expect(hasTable("workflow_agents")).toBe(1);
  });

  it("idempotently adds usage.run_id and usage.agent_id to a pre-existing usage table", () => {
    const db = new Database(":memory:");
    // A usage table predating the workflow columns.
    db.exec(`CREATE TABLE usage (message_uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL, at INTEGER NOT NULL);`);
    migrate(db);
    const has = (col: string) =>
      (db.query("PRAGMA table_info(usage)").all() as { name: string }[]).filter((c) => c.name === col).length;
    expect(has("run_id")).toBe(1);
    expect(has("agent_id")).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has("run_id")).toBe(1);
    expect(has("agent_id")).toBe(1);
  });

  it("idempotently adds sessions.idle_reason to a pre-existing table", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const has = () => (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).filter((c) => c.name === "idle_reason").length;
    expect(has()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(has()).toBe(1);
  });

  it("idempotently adds the events columns (tool_name, duration_ms, agent_id, harness) and the type/id index", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT, at INTEGER NOT NULL);`);
    migrate(db);
    const cols = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    for (const col of ["tool_name", "duration_ms", "agent_id", "harness"]) expect(cols).toContain(col);
    const hasIndex = (name: string) =>
      (db.query("SELECT name FROM sqlite_master WHERE type='index' AND name=$n").all({ $n: name }) as unknown[]).length;
    expect(hasIndex("idx_events_type_id")).toBe(1);
    expect(hasIndex("idx_events_at")).toBe(1); // the hourly retention prune's WHERE at < cutoff
    migrate(db); // second run must not throw or duplicate
    const cols2 = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    expect(cols2.filter((c) => c === "tool_name").length).toBe(1);
  });

  it("idempotently creates the tool_stats table", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, started_at INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL DEFAULT 0);`);
    migrate(db);
    const hasTable = () => (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_stats'").all() as unknown[]).length;
    expect(hasTable()).toBe(1);
    migrate(db); // second run must not throw or duplicate
    expect(hasTable()).toBe(1);
  });

  it("stores an unknown workflow status verbatim (no enum, no CHECK)", () => {
    store.db
      .query(
        `INSERT INTO workflow_runs (run_id, session_id, status, dir) VALUES ('wf_x', 's1', 'brand-new-status', '/tmp/x')`
      )
      .run();
    const row = store.db.query("SELECT status FROM workflow_runs WHERE run_id = 'wf_x'").get() as { status: string };
    expect(row.status).toBe("brand-new-status");
  });
});

describe("Store events + tool stats", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  function recordActivity(opts: { tool: string; dur?: number | null; agent?: string | null; harness?: string }) {
    store.recordEvent({
      sessionId: "s1",
      type: "activity",
      payload: JSON.stringify({ tool_name: opts.tool, tool_input: {} }),
      at: 1000,
      toolName: opts.tool,
      durationMs: opts.dur ?? null,
      agentId: opts.agent ?? null,
      harness: opts.harness ?? "claude",
    });
  }

  it("recordEvent inserts the row AND upserts tool_stats atomically for activity rows", () => {
    recordActivity({ tool: "Bash", dur: 100 });
    recordActivity({ tool: "Bash", dur: 300 });
    const row = store.db.query("SELECT calls, timed, total_ms FROM tool_stats WHERE harness='claude' AND tool='Bash'").get() as any;
    expect(row).toEqual({ calls: 2, timed: 2, total_ms: 400 });
    expect((store.db.query("SELECT COUNT(*) AS n FROM events").get() as any).n).toBe(2);
  });

  it("recordEvent does not touch tool_stats for a non-activity type or a missing tool name", () => {
    store.recordEvent({ sessionId: "s1", type: "tool_start", payload: "{}", at: 1, toolName: "Bash", durationMs: null, agentId: null, harness: "claude" });
    store.recordEvent({ sessionId: "s1", type: "activity", payload: "{}", at: 1, toolName: null, durationMs: null, agentId: null, harness: "claude" });
    expect((store.db.query("SELECT COUNT(*) AS n FROM tool_stats").get() as any).n).toBe(0);
  });

  it("toolStats sums across harnesses per tool and reports a per-harness breakdown, busiest first", () => {
    recordActivity({ tool: "Bash", dur: 100, harness: "claude" });
    recordActivity({ tool: "Bash", dur: 200, harness: "claude" });
    recordActivity({ tool: "Bash", dur: 900, harness: "cursor" });
    recordActivity({ tool: "Read", dur: 6, harness: "claude" });
    const stats = store.toolStats();
    expect(stats[0].tool).toBe("Bash"); // 3 calls beats Read's 1
    expect(stats[0].calls).toBe(3);
    expect(stats[0].totalMs).toBe(1200);
    expect(stats[0].avgMs).toBe(400);
    const byHarness = stats[0].byHarness.sort((a, b) => a.harness.localeCompare(b.harness));
    expect(byHarness).toEqual([
      { harness: "claude", calls: 2, totalMs: 300, avgMs: 150 },
      { harness: "cursor", calls: 1, totalMs: 900, avgMs: 900 },
    ]);
  });

  it("pruneOldEvents deletes rows at/after the cutoff boundary correctly (before cutoff only)", () => {
    store.db.query(`INSERT INTO events (session_id, type, payload, at) VALUES ('s', 'activity', '{}', 100)`).run();
    store.db.query(`INSERT INTO events (session_id, type, payload, at) VALUES ('s', 'activity', '{}', 200)`).run();
    const deleted = store.pruneOldEvents(200);
    expect(deleted).toBe(1); // only the row strictly before the cutoff
    expect((store.db.query("SELECT at FROM events").get() as any).at).toBe(200);
  });

  it("pruneOldEvents' DELETE ... WHERE at < $cutoff uses idx_events_at rather than a full table scan", () => {
    const plan = store.db.query("EXPLAIN QUERY PLAN DELETE FROM events WHERE at < $cutoff").all({ $cutoff: 1 }) as {
      detail: string;
    }[];
    expect(plan.some((p) => p.detail.includes("idx_events_at"))).toBe(true);
    expect(plan.some((p) => p.detail.startsWith("SCAN events"))).toBe(false);
  });

  it("recentActivity reads tool/duration/agent_id/harness from columns and still shows a row whose payload fails to parse", () => {
    store.recordEvent({
      sessionId: "s1",
      type: "activity",
      payload: "{not json",
      at: 1000,
      toolName: "Bash",
      durationMs: 42,
      agentId: "agent-1",
      harness: "cursor",
    });
    const rows = store.recentActivity(10);
    expect(rows.length).toBe(1);
    expect(rows[0].tool).toBe("Bash");
    expect(rows[0].dur).toBe(42);
    expect(rows[0].agent_id).toBe("agent-1");
    expect(rows[0].harness).toBe("cursor");
    expect(rows[0].detail).toBeNull(); // payload didn't parse -- no detail, but the row still appears
  });

  it("recentActivity attaches a known workflow agent's label", () => {
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1" });
    store.upsertWorkflowAgent({ run_id: "wf_1", agent_id: "a1", label: "map:packages" });
    recordActivity({ tool: "Bash", agent: "a1" });
    const rows = store.recentActivity(10);
    expect(rows[0].label).toBe("map:packages");
  });

  it("recentActivity leaves label null for an activity with no matching workflow agent", () => {
    recordActivity({ tool: "Bash" });
    expect(store.recentActivity(10)[0].label).toBeNull();
  });
});

describe("Store todos", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(":memory:"));
  });

  it("creates a todo in the 'todo' status with incrementing position", () => {
    const a = store.createTodo({ title: "Set a reminder", note: "branch feat/pay" }, 5000);
    const b = store.createTodo({ title: "Review PR", note: "" }, 5001);
    expect(a.status).toBe("todo");
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
    const u = store.updateTodo(t.id, { status: "done", note: "passed to Sam" }, 6000)!;
    expect(u.status).toBe("done");
    expect(u.note).toBe("passed to Sam");
    expect(u.updated_at).toBe(6000);
  });

  it("filters by status", () => {
    store.createTodo({ title: "a", note: "" }, 1);
    const b = store.createTodo({ title: "b", note: "" }, 2);
    store.updateTodo(b.id, { status: "done" }, 3);
    expect(store.listTodos("todo").length).toBe(1);
    expect(store.listTodos("done").length).toBe(1);
  });

  it("deletes a todo", () => {
    const t = store.createTodo({ title: "x", note: "" }, 1);
    expect(store.deleteTodo(t.id)).toBe(true);
    expect(store.listTodos().length).toBe(0);
    expect(store.deleteTodo("nope")).toBe(false);
  });

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
});

describe("Store workflows", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("inserts a run, then enriches it without clobbering earlier non-null fields", () => {
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 100 });
    store.upsertWorkflowRun({
      run_id: "wf_1", session_id: "s1", dir: "/d/wf_1",
      name: "research", status: "completed", manifest_seen: true, last_seen_at: 200,
      phases: JSON.stringify([{ title: "Explore", detail: null }]),
    });
    const row = store.db.query("SELECT * FROM workflow_runs WHERE run_id = 'wf_1'").get() as any;
    expect(row.name).toBe("research");
    expect(row.status).toBe("completed");
    expect(row.manifest_seen).toBe(1);
    expect(row.last_seen_at).toBe(200);
    // A later tick that knows less must not blank what an earlier one learned.
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 300 });
    const after = store.db.query("SELECT name, status, last_seen_at FROM workflow_runs WHERE run_id = 'wf_1'").get() as any;
    expect(after.name).toBe("research");
    expect(after.last_seen_at).toBe(300);
  });

  it("stamps project/branch from the owning session at first sight and keeps them", () => {
    store.applyEvent("s1", { status: "working", project: "alpha", branch: "feat/x", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 1 });
    store.applyEvent("s1", { branch: "main", last_activity_at: 2 }, 2); // session moves on
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 2 });
    const row = store.db.query("SELECT project, branch FROM workflow_runs WHERE run_id = 'wf_1'").get();
    expect(row).toEqual({ project: "alpha", branch: "feat/x" });
  });

  it("leaves project/branch NULL for a run whose session row does not exist", () => {
    store.upsertWorkflowRun({ run_id: "wf_2", session_id: "ghost", dir: "/d/wf_2", last_seen_at: 1 });
    const row = store.db.query("SELECT project, branch FROM workflow_runs WHERE run_id = 'wf_2'").get();
    expect(row).toEqual({ project: null, branch: null });
  });

  it("upserts agents idempotently and never resets a stored byte offset", () => {
    store.upsertWorkflowAgent({ run_id: "wf_1", agent_id: "a1", state: "running" });
    store.setWorkflowAgentOffset("wf_1", "a1", 4096);
    store.upsertWorkflowAgent({ run_id: "wf_1", agent_id: "a1", state: "done", label: "read:saga" });
    const row = store.db.query("SELECT state, label, offset FROM workflow_agents WHERE run_id='wf_1' AND agent_id='a1'").get() as any;
    expect(row.state).toBe("done");
    expect(row.label).toBe("read:saga");
    expect(row.offset).toBe(4096); // the tail position survives enrichment
    expect(store.workflowAgentOffsets("wf_1")).toEqual([{ agent_id: "a1", offset: 4096 }]);
  });

  it("workflowRunsToScan returns recent runs with the owning session's status joined in", () => {
    store.applyEvent("live", { status: "working", last_activity_at: 1 }, 1);
    store.applyEvent("dead", { status: "ended", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_recent", session_id: "live", dir: "/d/a", last_seen_at: 5_000 });
    store.upsertWorkflowRun({ run_id: "wf_ended", session_id: "dead", dir: "/d/b", last_seen_at: 5_000 });
    store.upsertWorkflowRun({ run_id: "wf_old", session_id: "live", dir: "/d/c", last_seen_at: 100 });

    const rows = store.workflowRunsToScan(1_000).sort((a, b) => a.run_id.localeCompare(b.run_id));
    expect(rows.map((r) => r.run_id)).toEqual(["wf_ended", "wf_recent"]); // wf_old is past the cutoff
    expect(rows.find((r) => r.run_id === "wf_ended")!.session_status).toBe("ended");
    expect(rows.find((r) => r.run_id === "wf_recent")!.session_status).toBe("working");
  });

  it("treats a purged owning session as ended so its runs read orphaned", () => {
    store.upsertWorkflowRun({ run_id: "wf_x", session_id: "ghost", dir: "/d/x", last_seen_at: 5_000 });
    expect(store.workflowRunsToScan(0)[0].session_status).toBe("ended");
  });

  it("carries manifest_mtime on the scan row so an in-place rewrite can be detected (C6)", () => {
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", manifest_seen: true, manifest_mtime: 111, last_seen_at: 1 });
    expect(store.getWorkflowRun("wf_1")!.manifest_mtime).toBe(111);
    // A tick that only re-stat'd the dir must not blank what the last parse stored.
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", last_seen_at: 2 });
    expect(store.getWorkflowRun("wf_1")!.manifest_mtime).toBe(111);
    // A re-parse after the rewrite advances it.
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d/wf_1", manifest_seen: true, manifest_mtime: 222, last_seen_at: 3 });
    expect(store.getWorkflowRun("wf_1")!.manifest_mtime).toBe(222);
  });

  it("getWorkflowRun returns null for an unknown run", () => {
    expect(store.getWorkflowRun("nope")).toBeNull();
  });
});
