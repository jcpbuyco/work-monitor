import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { SseHub } from "../src/server/sse.ts";
import { createApp, buildState } from "../src/server/http.ts";
import { resetDegraded, bumpDegraded } from "../src/server/workflows.ts";

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
