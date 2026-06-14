import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
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

  it("sweepStale moves stale working sessions to idle", () => {
    store.applyEvent("s1", reduceEvent({ wm_event_type: "session_start", session_id: "s1", cwd: "/x/b" }, 1000).patch, 1000);
    const affected = store.sweepStale(1000 + 11 * 60 * 1000, 10 * 60 * 1000);
    expect(affected).toContain("s1");
    expect(store.getSession("s1")!.status).toBe("idle");
  });
});

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
