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
