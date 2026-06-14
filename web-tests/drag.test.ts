import { describe, it, expect } from "vitest";
import { resolveDrop } from "../src/web/drag.ts";
import type { Todo } from "../src/web/types.ts";

const todo = (id: string, status: Todo["status"]): Todo => ({
  id, title: id, note: "", for_who: null, status,
  origin_project: null, branch: null, links: null, position: 0,
});

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
