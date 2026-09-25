import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { createApp, buildState, createStateScheduler, shouldApplyGitInfo } from "../src/server/http.ts";
import { resetDegraded, bumpDegraded, workflowsDegraded } from "../src/server/workflows.ts";
import { WF_QUIET_MS } from "../src/server/config.ts";

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
  // The SSE stream test leaves a connection open (by design - that is the
  // long-lived /api/stream response) and `reader.cancel()` on the client does
  // not synchronously tear down the server-side socket. Without this,
  // server.close() waits forever for that connection to end.
  server.closeAllConnections?.();
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
    const state = await (await fetch(`${base}/api/state`)).json() as any;
    expect(state.sessions.length).toBe(1);
    expect(state.sessions[0].project).toBe("browns");
    expect(state.sessions[0].status).toBe("working");
    expect(state.sessions[0].branch).toBeNull();
  });

  it("ignores events with no session_id (204, no crash)", async () => {
    const res = await fetch(`${base}/events?type=stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(204);
  });

  it("surfaces recent tool calls (newest first) in /api/state activity", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "sa", cwd: "/x/repo" });
    await post("activity", { session_id: "sa", cwd: "/x/repo", tool_name: "Read", tool_input: { file_path: "/x/repo/src/web/Board.tsx" } });
    await post("activity", { session_id: "sa", cwd: "/x/repo", tool_name: "Bash", tool_input: { description: "run tests", command: "bun test" }, duration_ms: 1500 });
    await post("activity", { session_id: "sa", cwd: "/x/repo" }); // no tool_name - excluded
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(Array.isArray(state.activity)).toBe(true);
    const tools = state.activity.map((a: any) => a.tool);
    expect(tools).toEqual(["Bash", "Read"]); // newest first, untagged event dropped
    expect(state.activity[0]).toHaveProperty("id");
    expect(state.activity[0].session_id).toBe("sa");
    // detail: bash prefers its description, file tools show the basename
    expect(state.activity[0].detail).toBe("run tests");
    expect(state.activity.find((a: any) => a.tool === "Read").detail).toBe("Board.tsx");
    // duration is surfaced when present
    expect(state.activity[0].dur).toBe(1500);
    expect(state.activity.find((a: any) => a.tool === "Read").dur).toBeNull();
  });

  it("aggregates per-tool usage stats (calls + avg) in /api/state", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "sc", cwd: "/x/repo" });
    await post("activity", { session_id: "sc", tool_name: "Bash", duration_ms: 100 });
    await post("activity", { session_id: "sc", tool_name: "Bash", duration_ms: 300 });
    await post("activity", { session_id: "sc", tool_name: "Read", duration_ms: 6 });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(Array.isArray(state.stats)).toBe(true);
    const bash = state.stats.find((s: any) => s.tool === "Bash");
    expect(bash.calls).toBe(2);
    expect(bash.avgMs).toBe(200); // (100 + 300) / 2
    expect(state.stats[0].tool).toBe("Bash"); // busiest first
  });

  it("tool_start sets active_tool; a completed tool clears it", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "sb", cwd: "/x/repo" });
    await post("tool_start", { session_id: "sb", cwd: "/x/repo", tool_name: "Bash" });
    let state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "sb").active_tool).toBe("Bash");
    await post("activity", { session_id: "sb", cwd: "/x/repo", tool_name: "Bash" });
    state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "sb").active_tool).toBeNull();
  });

  it("an activity heartbeat brings an idle session back to working", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "s9", cwd: "/x/foo" });
    await post("stop", { session_id: "s9" });
    const res = await post("activity", { session_id: "s9", cwd: "/x/foo" });
    expect(res.status).toBe(204);
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "s9").status).toBe("working");
  });

  it("session_end also sweeps that session's Task subagents (§2.4, finding), not just the parent transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-http-subagents-"));
    try {
      const transcriptPath = join(dir, "s-sub2.jsonl");
      writeFileSync(transcriptPath, "");
      const subDir = join(dir, "s-sub2", "subagents");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        join(subDir, "agent-a1.jsonl"),
        JSON.stringify({
          uuid: "u1",
          isSidechain: true,
          timestamp: "2026-08-01T08:00:00.000Z",
          message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 } },
        }) + "\n"
      );
      const post = (type: string, body: object) =>
        fetch(`${base}/events?type=${type}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      await post("session_start", { session_id: "s-sub2", cwd: dir, transcript_path: transcriptPath });
      await post("session_end", { session_id: "s-sub2" });
      const row = store.db.query("SELECT session_id, agent_id FROM usage").get();
      expect(row).toEqual({ session_id: "s-sub2", agent_id: "a1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop sets idle_reason 'stopped' (surfaced in state)", async () => {
    // 'quiet' is sweepStale-driven, not reachable through an HTTP event -- it
    // is covered directly in tests/store.test.ts instead.
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "s-idle", cwd: "/x/foo" });
    await post("stop", { session_id: "s-idle" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "s-idle").idle_reason).toBe("stopped");
  });

  it("§1.5: a subagent event (agent_id in payload) only bumps last_activity_at -- it cannot change project/branch/status/attention_reason/active_tool", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "s-sub", cwd: "/x/mainrepo" });
    await post("tool_start", { session_id: "s-sub", cwd: "/x/mainrepo", tool_name: "Bash" });
    // A subagent's own tool activity: different cwd, would-be notification-like
    // fields, and a tool call -- none of it may steer the main session.
    await post("activity", {
      session_id: "s-sub",
      cwd: "/somewhere/else/entirely",
      tool_name: "Read",
      agent_id: "agent-1",
    });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "s-sub");
    expect(s.project).toBe("mainrepo"); // untouched by the subagent's different cwd
    expect(s.active_tool).toBe("Bash"); // NOT cleared by the subagent's activity
    expect(s.status).toBe("working");
  });

  it("§1.5: a subagent notification does not put the session into needs_you", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "s-sub2", cwd: "/x/repo" });
    await post("notification", { session_id: "s-sub2", message: "a subagent question", agent_id: "agent-9" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "s-sub2");
    expect(s.status).toBe("working");
    expect(s.attention_reason).toBeNull();
  });

  it("§1.5: a subagent event still bumps last_activity_at and is stored as activity", async () => {
    const post = (type: string, body: object) =>
      fetch(`${base}/events?type=${type}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("session_start", { session_id: "s-sub3", cwd: "/x/repo" });
    const before = (await (await fetch(`${base}/api/state`)).json()) as any;
    const t0 = before.sessions.find((x: any) => x.id === "s-sub3").last_activity_at;
    await new Promise((r) => setTimeout(r, 5));
    await post("activity", { session_id: "s-sub3", tool_name: "Bash", agent_id: "agent-1" });
    const after = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = after.sessions.find((x: any) => x.id === "s-sub3");
    expect(s.last_activity_at).toBeGreaterThan(t0);
    expect(after.activity.some((a: any) => a.session_id === "s-sub3" && a.agent_id === "agent-1")).toBe(true);
  });

  it("§1.2: stores a compacted (never raw-sliced) payload -- redundant fields are dropped, and the row is always valid JSON", async () => {
    await fetch(`${base}/events?type=activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s-compact",
        cwd: "/x/repo",
        tool_name: "Read",
        tool_input: { file_path: "/x/repo/a.ts" },
        tool_response: "x".repeat(50_000),
      }),
    });
    const rows = store.db.query("SELECT payload FROM events WHERE session_id = 's-compact'").all() as { payload: string }[];
    expect(rows.length).toBe(1);
    const parsed = JSON.parse(rows[0].payload); // must not throw
    expect(parsed.tool_response).toBeUndefined();
    expect(parsed.tool_name).toBe("Read");
  });
});

describe("§1.5 no-downgrade rule, wired end-to-end through POST /events", () => {
  let dir: string;
  let repo: string;
  let nonGit: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "am-http-gitwt-"));
    repo = join(dir, "myproj");
    const G = (...args: string[]) =>
      execFileSync("git", args, {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    G("init", "-q", repo);
    G("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    nonGit = join(dir, "scratch"); // a plain directory, never git-init'd
    execFileSync("mkdir", ["-p", nonGit]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const post = (type: string, body: object) =>
    fetch(`${base}/events?type=${type}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("never downgrades a session already resolved from git when a later event's cwd isn't a repo", async () => {
    await post("session_start", { session_id: "s-git", cwd: repo });
    let state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "s-git").project).toBe("myproj");

    // A later event for the SAME session whose cwd resolveRepoInfo cannot
    // resolve from git at all -- must not knock the session back to a
    // basename fallback.
    await post("activity", { session_id: "s-git", cwd: nonGit, tool_name: "Bash" });
    state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "s-git");
    expect(s.project).toBe("myproj"); // unchanged, not "scratch"
  });

  it("recovers from 'unknown' once a main-agent event with a resolvable cwd finally arrives", async () => {
    // The session's FIRST event is a subagent's: applyEvent's own insert
    // fallback stamps project "unknown" since a subagent patch carries no
    // project field at all -- this session has never been resolved from git.
    await post("activity", { session_id: "s-late-main", agent_id: "agent-1", tool_name: "Read" });
    let state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "s-late-main").project).toBe("unknown");

    // The first MAIN-agent event for this session, with a real repo cwd, must
    // still resolve it -- an "unknown" project is not a git-resolved one that
    // the no-downgrade rule should protect.
    await post("tool_start", { session_id: "s-late-main", cwd: repo, tool_name: "Bash" });
    state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "s-late-main").project).toBe("myproj");
  });
});

describe("createStateScheduler (§1.1 coalesced broadcasts)", () => {
  it("collapses a synchronous burst into one sse.broadcast(\"state\", ...) call, off the current tick", async () => {
    const calls: unknown[][] = [];
    const fakeSse = { broadcast: (...args: unknown[]) => calls.push(args) } as any;
    const s = new Store(openDb(":memory:"));
    const schedule = createStateScheduler(s, fakeSse, 1000);
    schedule();
    schedule();
    schedule();
    expect(calls.length).toBe(0); // not synchronous -- next macrotask
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("state");
  });

  it("logs once and bumps workflows_degraded instead of throwing when the broadcast fn itself throws", async () => {
    resetDegraded();
    const s = new Store(openDb(":memory:"));
    // Force buildState() to throw for this Store instance only.
    (s as unknown as { listSessions: () => never }).listSessions = () => {
      throw new Error("boom");
    };
    const fakeSse = { broadcast: () => {} } as any;
    const schedule = createStateScheduler(s, fakeSse, 0);
    expect(() => schedule()).not.toThrow();
    await new Promise((r) => setTimeout(r, 20)); // let the throttle's macrotask fire
    expect(workflowsDegraded()).toBeGreaterThan(0);
  });
});

describe("shouldApplyGitInfo (§1.5 no-downgrade rule)", () => {
  it("always applies a successful git resolution, new or existing session", () => {
    expect(shouldApplyGitInfo(true, false)).toBe(true);
    expect(shouldApplyGitInfo(true, true)).toBe(true);
  });
  it("applies a basename fallback only to a brand-new session", () => {
    expect(shouldApplyGitInfo(false, false)).toBe(true);
  });
  it("never downgrades an existing session to a basename fallback", () => {
    expect(shouldApplyGitInfo(false, true)).toBe(false);
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
    ).json() as any;
    expect(created.status).toBe("todo");

    const patched = await (
      await fetch(`${base}/api/todos/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      })
    ).json() as any;
    expect(patched.status).toBe("done");

    const del = await fetch(`${base}/api/todos/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const state = await (await fetch(`${base}/api/state`)).json() as any;
    expect(state.todos.length).toBe(0);
  });
});

describe("buildState", () => {
  it("includes a cost block with the expected shape", () => {
    const s = new Store(openDb(":memory:"));
    const state = buildState(s);
    expect(state.cost).toBeDefined();
    expect(state.cost.perSession).toEqual({});
    expect(state.cost.liveTotalUsd).toBe(0);
    // No usage rows at all -- SUM(cost_usd) is NULL, never coalesced to a
    // fabricated $0.00 (§2.3, finding); this differs from liveTotalUsd, which
    // masks its own "no live sessions" case (a real, known zero, not an
    // unknown) deliberately.
    expect(state.cost.todayUsd).toBeNull();
    expect(state.cost.unpricedTokens).toBe(0);
    expect(state.cost.unpricedModels).toEqual([]);
    expect(state.cost.byModelToday).toEqual([]);
    expect(state.cost.byProject).toEqual([]);
    expect(state.cost.byBranch).toEqual([]);
  });
});

describe("MCP route without deps", () => {
  it("returns 503 when no mcp deps are wired", async () => {
    const res = await fetch(`${base}/mcp`, { method: "GET" });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/cost/daily", () => {
  it("returns per-project/branch/day rows and respects since", async () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    const z = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    store.recordUsage({ uuid: "u1", sessionId: "a", model: "claude-opus-4-8", tokens: z, at: T, cost: 1.0 });
    store.recordUsage({ uuid: "u2", sessionId: "a", model: "claude-opus-4-8", tokens: z, at: T + 26 * 3600 * 1000, cost: 2.0 });

    const all = (await (await fetch(`${base}/api/cost/daily`)).json()) as any;
    expect(all.rows.length).toBe(2);
    expect(all.rows[0]).toHaveProperty("day");
    expect(all.rows[0]).toHaveProperty("costUsd");

    const ranged = (await (await fetch(`${base}/api/cost/daily?since=${T + 1}`)).json()) as any;
    expect(ranged.rows.length).toBe(1);
    expect(ranged.rows[0].costUsd).toBeCloseTo(2.0, 6);
  });

  it("ignores malformed since/until rather than erroring", async () => {
    const res = await fetch(`${base}/api/cost/daily?since=abc&until=xyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("§5.3: returns a harness column, and the harness param narrows to it", async () => {
    store.applyEvent("h", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    const z = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    store.recordUsage({ uuid: "hu1", sessionId: "h", model: "claude-opus-4-8", tokens: z, at: T, cost: 1.0, harness: "claude" });
    store.recordUsage({ uuid: "hu2", sessionId: "h", model: "gpt-5.3-codex", tokens: z, at: T, cost: 2.0, harness: "codex" });

    const all = (await (await fetch(`${base}/api/cost/daily`)).json()) as any;
    expect(new Set(all.rows.map((r: any) => r.harness))).toEqual(new Set(["claude", "codex"]));

    const codexOnly = (await (await fetch(`${base}/api/cost/daily?harness=codex`)).json()) as any;
    expect(codexOnly.rows.length).toBe(1);
    expect(codexOnly.rows[0].costUsd).toBeCloseTo(2.0, 6);
  });
});

describe("GET /api/workflows", () => {
  const T = 1_700_000_000_000;

  function seed(runId: string, startedAt: number) {
    store.applyEvent("p", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({
      run_id: runId, session_id: "p", dir: `/d/${runId}`, name: "research", status: "completed",
      manifest_seen: true, last_seen_at: startedAt, started_at: startedAt,
    });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a1", label: "map", state: "done" });
    const z = { input: 10, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };
    store.recordUsage({ uuid: `${runId}-1`, sessionId: "p", model: "claude-opus-5", tokens: z, at: startedAt, cost: 2.5, runId, agentId: "a1" });
  }

  it("returns runs WITHOUT agents, plus an agent_counts rollup and total (§3)", async () => {
    seed("wf_a", T);
    const body = (await (await fetch(`${base}/api/workflows`)).json()) as any;
    expect(body.total).toBe(1);
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].run_id).toBe("wf_a");
    expect(body.runs[0].project).toBe("alpha");
    expect(body.runs[0].costUsd).toBeCloseTo(2.5, 6);
    expect(body.runs[0].agents).toBeUndefined();
    expect(body.runs[0].agent_counts).toEqual({ total: 1, done: 1, error: 0, running: 0, abandoned: 0, killed: 0 });
  });

  it("normalizes progress/running agents to killed in agent_counts for a settled killed/failed run, matching the detail view (§3 spec gap)", async () => {
    store.applyEvent("p2", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({
      run_id: "wf_killed", session_id: "p2", dir: "/d/wf_killed", name: "research", status: "killed",
      manifest_seen: true, last_seen_at: T - WF_QUIET_MS - 1, started_at: T,
    });
    store.upsertWorkflowAgent({ run_id: "wf_killed", agent_id: "a1", label: "map", state: "progress" });
    store.upsertWorkflowAgent({ run_id: "wf_killed", agent_id: "a2", label: "scout", state: "done" });
    const list = (await (await fetch(`${base}/api/workflows?q=research`)).json()) as any;
    const row = list.runs.find((r: any) => r.run_id === "wf_killed");
    expect(row.agent_counts).toEqual({ total: 2, done: 1, error: 0, running: 0, abandoned: 0, killed: 1 });
    const detail = (await (await fetch(`${base}/api/workflows/wf_killed`)).json()) as any;
    expect(detail.agents.map((a: any) => a.state).sort()).toEqual(["done", "killed"]);
  });

  it("GET /api/workflows/:runId returns the one run WITH its agents", async () => {
    seed("wf_a", T);
    const res = await fetch(`${base}/api/workflows/wf_a`);
    expect(res.status).toBe(200);
    const run = (await res.json()) as any;
    expect(run.run_id).toBe("wf_a");
    expect(run.agents[0].agent_id).toBe("a1");
    expect(run.agents[0].costUsd).toBeCloseTo(2.5, 6);
    expect((await fetch(`${base}/api/workflows/no-such-run`)).status).toBe(404);
  });

  it("respects since/until/limit/offset and a q substring filter", async () => {
    seed("wf_a", T);
    seed("wf_b", T + 5000);
    const ranged = (await (await fetch(`${base}/api/workflows?since=${T + 1}`)).json()) as any;
    expect(ranged.runs.map((r: any) => r.run_id)).toEqual(["wf_b"]);
    const capped = (await (await fetch(`${base}/api/workflows?limit=1`)).json()) as any;
    expect(capped.runs.length).toBe(1);
    expect(capped.total).toBe(2); // total counts the whole match, not just this page
    const offsetPage = (await (await fetch(`${base}/api/workflows?limit=1&offset=1`)).json()) as any;
    expect(offsetPage.runs.map((r: any) => r.run_id)).toEqual(["wf_a"]); // newest first: wf_b, then wf_a
    const searched = (await (await fetch(`${base}/api/workflows?q=alpha`)).json()) as any;
    expect(searched.runs.map((r: any) => r.run_id).sort()).toEqual(["wf_a", "wf_b"]);
    const missed = (await (await fetch(`${base}/api/workflows?q=nonesuch`)).json()) as any;
    expect(missed.runs).toEqual([]);
  });

  it("ignores malformed params rather than erroring", async () => {
    const res = await fetch(`${base}/api/workflows?since=abc&until=xyz&limit=nope&offset=nope`);
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as any).runs)).toBe(true);
  });

  it("§5.3: the project param filters to an exact project match", async () => {
    seed("wf_a", T); // project "alpha"
    store.applyEvent("q", { status: "working", project: "alphabet", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_b", session_id: "q", dir: "/d/wf_b", name: "research", status: "completed", manifest_seen: true, last_seen_at: T, started_at: T });
    const alpha = (await (await fetch(`${base}/api/workflows?project=alpha`)).json()) as any;
    expect(alpha.runs.map((r: any) => r.run_id)).toEqual(["wf_a"]);
    const alphabet = (await (await fetch(`${base}/api/workflows?project=alphabet`)).json()) as any;
    expect(alphabet.runs.map((r: any) => r.run_id)).toEqual(["wf_b"]);
  });

  it("keeps workflows OUT of the state blob (buildState must not get slower)", () => {
    const state = buildState(store) as any;
    expect(state.workflows).toBeUndefined();
  });
});

describe("workflows on the stream", () => {
  it("emits BOTH state and workflows on connect", async () => {
    const res = await fetch(`${base}/api/stream`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = dec.decode((await reader.read()).value);
    if (!seen.includes("event: workflows")) seen += dec.decode((await reader.read()).value);
    expect(seen).toContain("event: state");
    expect(seen).toContain("event: workflows");
    await reader.cancel();
  });

  it("exposes workflows_degraded as a top-level scalar reflecting the shared counter, not nested under cost", () => {
    // `typeof === "number"` alone would pass for a hardcoded `workflows_degraded: 0`
    // in buildState() - drive the counter to a known, non-zero value through its
    // own public API and assert buildState() reflects that EXACT value, proving
    // it is actually wired to workflowsDegraded() and not a stub.
    resetDegraded();
    bumpDegraded(3);
    const state = buildState(store) as any;
    expect(state.workflows_degraded).toBe(3);
    expect(state.cost.workflows_degraded).toBeUndefined();
  });

  it("carries workflows_degraded_run: null when nothing is degraded, named when it is (§5.2 banner)", () => {
    expect((buildState(store) as any).workflows_degraded_run).toBeNull();
    store.recordRunDegraded({ run_id: "wf_1", session_id: "s1", dir: "/d" }, "scan", Date.now());
    store.upsertWorkflowRun({ run_id: "wf_1", session_id: "s1", dir: "/d", name: "research" });
    expect((buildState(store) as any).workflows_degraded_run).toEqual({ run_id: "wf_1", name: "research" });
  });
});

describe("todo input validation", () => {
  it("rejects malformed JSON on POST with 400", async () => {
    const res = await fetch(`${base}/api/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid status on PATCH with 400 and does not corrupt the card", async () => {
    const created = await (
      await fetch(`${base}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", note: "" }),
      })
    ).json() as any;
    const bad = await fetch(`${base}/api/todos/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "garbage" }),
    });
    expect(bad.status).toBe(400);
    const state = await (await fetch(`${base}/api/state`)).json() as any;
    expect(state.todos[0].status).toBe("todo");
  });

  it("accepts a null note on PATCH without a 500", async () => {
    const created = await (
      await fetch(`${base}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", note: "x" }),
      })
    ).json() as any;
    const res = await fetch(`${base}/api/todos/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.note).toBe("");
  });

  it("rejects an invalid status filter on GET with 400", async () => {
    const res = await fetch(`${base}/api/todos?status=handed_off`);
    expect(res.status).toBe(400);
  });
});

describe("§4 multi-harness ingestion, wired end-to-end through POST /events", () => {
  const post = (type: string, body: object, qs: string = "") =>
    fetch(`${base}/events?type=${type}${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("Cursor: detected from cursor_version, cwd falls back to workspace_roots[0], model persists", async () => {
    await post("session_start", {
      conversation_id: "c1",
      session_id: "c1",
      model: "grok-4.7-low",
      cursor_version: "2026.09.23-86fc751",
      workspace_roots: ["/x/cursor-project"],
      cwd: null,
    });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "c1");
    expect(s.harness).toBe("cursor");
    expect(s.project).toBe("cursor-project"); // resolved from workspace_roots[0], not a null cwd
    expect(s.model).toBe("grok-4.7-low");
    expect(s.harness_version).toBe("2026.09.23-86fc751");
  });

  it("Codex: detected from a ~/.codex/ transcript_path, model persists, PermissionRequest synthesizes a message", async () => {
    await post("session_start", {
      session_id: "x1",
      cwd: "/x/codex-project",
      transcript_path: "/home/user/.codex/sessions/2026/09/25/rollout-x.jsonl",
      model: "gpt-5.5",
    });
    await post("notification", {
      session_id: "x1",
      cwd: "/x/codex-project",
      transcript_path: "/home/user/.codex/sessions/2026/09/25/rollout-x.jsonl",
      model: "gpt-5.5",
    });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "x1");
    expect(s.harness).toBe("codex");
    expect(s.model).toBe("gpt-5.5");
    expect(s.status).toBe("needs_you");
    expect(s.attention_reason).toBe("Codex is waiting for approval");
  });

  it("Codex: detected via the harness=codex query param before any transcript_path is known", async () => {
    await post("session_start", { session_id: "x2", cwd: "/x/codex-project2" }, "&harness=codex");
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "x2").harness).toBe("codex");
  });

  it("Claude: session_start's model/session_title persist onto the session", async () => {
    await post("session_start", {
      session_id: "cc1",
      cwd: "/x/claude-project",
      model: "claude-opus-5-5[1m]",
      session_title: "Fix the login bug",
    });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "cc1");
    expect(s.harness).toBe("claude");
    expect(s.model).toBe("claude-opus-5-5[1m]");
    expect(s.title).toBe("Fix the login bug");
  });

  it("parent resolution: pcc query param sets parent_session_id once and it is never overwritten", async () => {
    await post("session_start", { session_id: "child1", cwd: "/x/repo" }, "&pcc=parent-abc");
    await post("activity", { session_id: "child1", cwd: "/x/repo", tool_name: "Bash" }); // no pcc this time
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "child1").parent_session_id).toBe("parent-abc");
  });

  it("parent resolution: falls back to the scratchpad cwd pattern when no pcc/pcx is given", async () => {
    const cwd = "/tmp/claude-1000/-slug/fe6382e2-c797-47f4-badb-da617338ebdf/scratchpad";
    await post("session_start", { session_id: "child2", cwd });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "child2").parent_session_id).toBe(
      "fe6382e2-c797-47f4-badb-da617338ebdf"
    );
  });

  it("a subagent event (carrying agent_id) never sets harness/model/title/parent on the session", async () => {
    await post("session_start", { session_id: "main1", cwd: "/x/repo" }); // claude, no model
    await post("activity", {
      session_id: "main1",
      cwd: "/x/repo",
      agent_id: "a1",
      tool_name: "Bash",
      cursor_version: "9.9.9", // even a (contrived) cursor-shaped subagent payload must not steer the session
      model: "grok-4.7",
    });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const s = state.sessions.find((x: any) => x.id === "main1");
    expect(s.harness).toBe("claude");
    expect(s.model).toBeNull();
  });

  it("Cursor: backfills current_intent from the session's own transcript once a transcript_path is known", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-http-cursor-transcript-"));
    const transcriptPath = join(dir, "t.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>fix the flaky test</user_query>" }] },
      }) + "\n"
    );
    try {
      await post("session_start", { session_id: "cur1", conversation_id: "cur1", cursor_version: "1.0.0" });
      await post("activity", {
        session_id: "cur1",
        conversation_id: "cur1",
        cursor_version: "1.0.0",
        tool_name: "Shell",
        transcript_path: transcriptPath,
      });
      const state = (await (await fetch(`${base}/api/state`)).json()) as any;
      expect(state.sessions.find((x: any) => x.id === "cur1").current_intent).toBe("fix the flaky test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session rows carry a live subagents array (empty with none active)", async () => {
    await post("session_start", { session_id: "s-plain", cwd: "/x/repo" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.sessions.find((x: any) => x.id === "s-plain").subagents).toEqual([]);
  });

  it("recentActivity rows carry harness and a session label", async () => {
    await post("session_start", { session_id: "sl1", cwd: "/x/labelled-project" });
    await post("prompt", { session_id: "sl1", cwd: "/x/labelled-project", prompt: "fix the thing" });
    await post("activity", { session_id: "sl1", cwd: "/x/labelled-project", tool_name: "Bash" });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    const row = state.activity.find((a: any) => a.session_id === "sl1");
    expect(row.harness).toBe("claude");
    expect(row.session_label).toBe("labelled-project - fix the thing");
  });
});

describe("POST /api/usage/cursor (am-cursor)", () => {
  const usage = { inputTokens: 12080, outputTokens: 109, cacheReadTokens: 10752, cacheWriteTokens: 0 };
  const post = (body: unknown) =>
    fetch(`${base}/api/usage/cursor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("records one unpriced cursor usage row, preferring the session's hook model, idempotently", async () => {
    await fetch(`${base}/events?type=session_start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "c1", cursor_version: "2026.09.23", model: "grok-4.7", workspace_roots: ["/x/app"] }),
    });
    const body = { session_id: "c1", request_id: "r1", model: "Grok 4.7 256K Low", usage, at: 1000 };
    expect((await post(body)).status).toBe(204);
    expect((await post(body)).status).toBe(204); // replay
    const rows = store.db.query("SELECT * FROM usage WHERE session_id = 'c1'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      harness: "cursor",
      model: "grok-4.7",
      message_key: "cursor:r1",
      input_tokens: 12080,
      output_tokens: 109,
      cache_read_tokens: 10752,
      cache_create_5m_tokens: 0,
      cost_usd: null,
    });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.cost.perSession.c1.tokens).toBe(12080 + 109 + 10752);
    expect(state.cost.perSession.c1.costUsd).toBeNull();
  });

  it("falls back to the payload model when the session is unknown", async () => {
    expect((await post({ session_id: "c2", request_id: "r2", model: "Grok 4.7", usage, at: 1 })).status).toBe(204);
    expect((store.db.query("SELECT model FROM usage WHERE session_id = 'c2'").get() as any).model).toBe("Grok 4.7");
  });

  it("ignores garbage without recording anything", async () => {
    for (const bad of ["not json", {}, { session_id: "c3" }, { session_id: "c3", usage: { inputTokens: "x" } }]) {
      expect((await post(bad)).status).toBe(204);
    }
    expect((store.db.query("SELECT count(*) AS n FROM usage").get() as any).n).toBe(0);
  });
});
