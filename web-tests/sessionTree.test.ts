import { describe, it, expect } from "vitest";
import { buildSessionTree } from "../src/web/sessionTree.ts";
import type { Session } from "../src/web/types.ts";

const mk = (over: Partial<Session>): Session => ({
  id: "s", project: "p", status: "working", current_task: null, current_intent: null,
  attention_reason: null, active_tool: null, branch: null, idle_reason: null,
  started_at: 0, last_activity_at: 0, ...over,
});

describe("buildSessionTree", () => {
  it("puts a session with no parent at the top level", () => {
    const parent = mk({ id: "p1" });
    const tree = buildSessionTree([parent], [parent]);
    expect(tree).toEqual([{ session: parent, children: [], spawnedByProject: null }]);
  });

  it("nests a child under its parent when both are in the same column", () => {
    const parent = mk({ id: "p1" });
    const child = mk({ id: "c1", project: "child-proj", parent_session_id: "p1" });
    const tree = buildSessionTree([parent, child], [parent, child]);
    expect(tree.length).toBe(1);
    expect(tree[0].session.id).toBe("p1");
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].session.id).toBe("c1");
    expect(tree[0].children[0].spawnedByProject).toBeNull(); // nested, not an orphan
  });

  it("nests multiple generations", () => {
    const grandparent = mk({ id: "g1" });
    const parent = mk({ id: "p1", parent_session_id: "g1" });
    const child = mk({ id: "c1", parent_session_id: "p1" });
    const tree = buildSessionTree([grandparent, parent, child], [grandparent, parent, child]);
    expect(tree[0].children[0].children[0].session.id).toBe("c1");
  });

  it("renders an orphan top-level with the parent's project, when the parent exists but isn't in this column", () => {
    const parent = mk({ id: "p1", project: "orchestrator", status: "idle" });
    const child = mk({ id: "c1", project: "child-proj", status: "working", parent_session_id: "p1" });
    // Only the child is in THIS column's list; the parent (idle) is elsewhere,
    // but still present in the full unfiltered set for the hint lookup.
    const tree = buildSessionTree([child], [parent, child]);
    expect(tree).toEqual([{ session: child, children: [], spawnedByProject: "orchestrator" }]);
  });

  it("renders an orphan with no hint when the parent can't be resolved at all (ended/gone)", () => {
    const child = mk({ id: "c1", parent_session_id: "gone" });
    const tree = buildSessionTree([child], [child]);
    expect(tree).toEqual([{ session: child, children: [], spawnedByProject: null }]);
  });

  it("keeps sibling order stable and does not duplicate a child under multiple parents", () => {
    const parent = mk({ id: "p1" });
    const c1 = mk({ id: "c1", parent_session_id: "p1" });
    const c2 = mk({ id: "c2", parent_session_id: "p1" });
    const tree = buildSessionTree([parent, c1, c2], [parent, c1, c2]);
    expect(tree.length).toBe(1);
    expect(tree[0].children.map((n) => n.session.id)).toEqual(["c1", "c2"]);
  });
});
