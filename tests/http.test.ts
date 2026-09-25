import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { createApp, buildState, createStateScheduler, shouldApplyGitInfo } from "../src/server/http.ts";
import { resetDegraded, bumpDegraded, workflowsDegraded } from "../src/server/workflows.ts";

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
  // The SSE stream test leaves a connection open (by design — that is the
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
    await post("activity", { session_id: "sa", cwd: "/x/repo" }); // no tool_name — excluded
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
    expect(state.cost.todayUsd).toBe(0);
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

  it("returns runs with embedded agents and usage rollups", async () => {
    seed("wf_a", T);
    const body = (await (await fetch(`${base}/api/workflows`)).json()) as any;
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].run_id).toBe("wf_a");
    expect(body.runs[0].project).toBe("alpha");
    expect(body.runs[0].costUsd).toBeCloseTo(2.5, 6);
    expect(body.runs[0].agents[0].agent_id).toBe("a1");
    expect(body.runs[0].agents[0].costUsd).toBeCloseTo(2.5, 6);
  });

  it("respects since/until/limit", async () => {
    seed("wf_a", T);
    seed("wf_b", T + 5000);
    const ranged = (await (await fetch(`${base}/api/workflows?since=${T + 1}`)).json()) as any;
    expect(ranged.runs.map((r: any) => r.run_id)).toEqual(["wf_b"]);
    const capped = (await (await fetch(`${base}/api/workflows?limit=1`)).json()) as any;
    expect(capped.runs.length).toBe(1);
  });

  it("ignores malformed params rather than erroring", async () => {
    const res = await fetch(`${base}/api/workflows?since=abc&until=xyz&limit=nope`);
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as any).runs)).toBe(true);
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
    // in buildState() — drive the counter to a known, non-zero value through its
    // own public API and assert buildState() reflects that EXACT value, proving
    // it is actually wired to workflowsDegraded() and not a stub.
    resetDegraded();
    bumpDegraded(3);
    const state = buildState(store) as any;
    expect(state.workflows_degraded).toBe(3);
    expect(state.cost.workflows_degraded).toBeUndefined();
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
