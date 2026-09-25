import { describe, it, expect } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { mergeOrphanMessageKeys, USAGE_ORPHAN_MERGE_MARKER } from "../src/server/usage-orphan-merge.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (output: number): Tokens => ({ input: 100, output, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });

describe("mergeOrphanMessageKeys", () => {
  it("merges a message-key-less row into the single keyed row sharing its content key, keeping the larger output and recomputed cost", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    // The "before" half: recorded by an older build, no message_key, small
    // (partial-streaming) output, at an earlier timestamp.
    store.recordUsage({ uuid: "old", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 100, cost: 0.01 });
    // The "after" half: recorded post-restart, correctly keyed, final output.
    store.recordUsage({
      uuid: "new", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(358), at: 105, cost: 0.5, messageKey: "msg_1:req_1",
    });

    const r = mergeOrphanMessageKeys(store);
    expect(r.merged).toBe(1);

    const rows = store.db.query("SELECT message_uuid, output_tokens, at, message_key FROM usage").all();
    expect(rows).toEqual([{ message_uuid: "new", output_tokens: 358, at: 100, message_key: "msg_1:req_1" }]);
    // cost recomputed from the merged (larger) output at opus-4-8's real rate,
    // not left at either original row's stale cost.
    const row = store.db.query("SELECT cost_usd FROM usage WHERE message_uuid = 'new'").get() as { cost_usd: number };
    expect(row.cost_usd).toBeCloseTo((100 * 5 + 358 * 25) / 1e6, 6);
  });

  it("leaves an orphan alone when it matches more than one keyed row (too ambiguous to merge safely)", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "old", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 100, cost: 0.01 });
    store.recordUsage({ uuid: "k1", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 101, cost: 0.02, messageKey: "msg_a:" });
    store.recordUsage({ uuid: "k2", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 102, cost: 0.02, messageKey: "msg_b:" });

    const r = mergeOrphanMessageKeys(store);
    expect(r.merged).toBe(0);
    const count = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(count.c).toBe(3); // nothing deleted
  });

  it("leaves an orphan alone when no keyed row matches its content key", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "solo", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 100, cost: 0.01 });
    const r = mergeOrphanMessageKeys(store);
    expect(r.merged).toBe(0);
    const count = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("respects agent_id in the content key -- two agents' identical-shaped orphan/keyed pairs never cross-merge", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("p", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "old-a1", sessionId: "p", agentId: "a1", model: "claude-opus-5", tokens: tok(2), at: 100, cost: 0.01 });
    store.recordUsage({ uuid: "new-a1", sessionId: "p", agentId: "a1", model: "claude-opus-5", tokens: tok(50), at: 101, cost: 0.3, messageKey: "m1:" });
    store.recordUsage({ uuid: "old-a2", sessionId: "p", agentId: "a2", model: "claude-opus-5", tokens: tok(2), at: 100, cost: 0.01 });
    store.recordUsage({ uuid: "new-a2", sessionId: "p", agentId: "a2", model: "claude-opus-5", tokens: tok(60), at: 101, cost: 0.35, messageKey: "m2:" });

    const r = mergeOrphanMessageKeys(store);
    expect(r.merged).toBe(2);
    const rows = store.db.query("SELECT message_uuid, agent_id, output_tokens FROM usage ORDER BY message_uuid").all();
    expect(rows).toEqual([
      { message_uuid: "new-a1", agent_id: "a1", output_tokens: 50 },
      { message_uuid: "new-a2", agent_id: "a2", output_tokens: 60 },
    ]);
  });

  it("is guarded by a marker so a restart cannot re-run it", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "old", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 100, cost: 0.01 });
    store.recordUsage({ uuid: "new", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(358), at: 105, cost: 0.5, messageKey: "msg_1:req_1" });
    mergeOrphanMessageKeys(store);
    expect(store.getMeta(USAGE_ORPHAN_MERGE_MARKER)).toBe("1");

    // A NEW orphan appearing after the marker is set (e.g. a genuinely
    // keyless line) must NOT be merged retroactively -- this pass never runs
    // again once its one job is done.
    store.recordUsage({ uuid: "later-old", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 200, cost: 0.01 });
    store.recordUsage({ uuid: "later-new", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(99), at: 201, cost: 0.4, messageKey: "msg_2:" });
    const r = mergeOrphanMessageKeys(store);
    expect(r.merged).toBe(0);
    const count = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(count.c).toBe(3); // "new", "later-old", "later-new" -- no further merging
  });

  it("bumps the cost-cache generation when it merges something", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "old", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(2), at: 100, cost: 0.01 });
    store.recordUsage({ uuid: "new", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(358), at: 105, cost: 0.5, messageKey: "msg_1:req_1" });
    const stale = store.costByProject();
    mergeOrphanMessageKeys(store);
    const fresh = store.costByProject();
    expect(fresh).not.toBe(stale);
  });
});
