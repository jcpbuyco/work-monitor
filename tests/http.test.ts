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
    await post("activity", { session_id: "sa", cwd: "/x/repo", tool_name: "Bash", tool_input: { description: "run tests", command: "bun test" } });
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

describe("MCP route without deps", () => {
  it("returns 503 when no mcp deps are wired", async () => {
    const res = await fetch(`${base}/mcp`, { method: "GET" });
    expect(res.status).toBe(503);
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
