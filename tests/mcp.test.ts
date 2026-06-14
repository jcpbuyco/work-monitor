import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { makeTools } from "../src/server/mcp.ts";

function tools() {
  const store = new Store(openDb(":memory:"));
  return { store, t: makeTools({ store, onChange: () => {}, now: () => 7000 }) };
}

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

  it("update_todo can move a todo from done back to todo", () => {
    const { store, t } = tools();
    const { id } = t.add_todo({ title: "a" });
    t.update_todo({ id, status: "done" });
    t.update_todo({ id, status: "todo" });
    expect(store.getTodo(id)!.status).toBe("todo");
  });
});
