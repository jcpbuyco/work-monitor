import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (input: number): Tokens => ({ input, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });

describe("Store usage rows", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(":memory:"));
  });

  it("records a usage row once per message uuid (dedup)", () => {
    const row = { uuid: "m1", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(100), at: 1000, cost: 0.5 };
    expect(store.recordUsage(row)).toBe(true);
    expect(store.recordUsage(row)).toBe(false); // same uuid → ignored
    const summary = store.costSummary(0);
    expect(summary.perSession.s1.costUsd).toBeCloseTo(0.5, 6);
  });

  it("tracks and updates the per-session usage offset", () => {
    store.applyEvent("s1", { status: "working", transcript_path: "/tmp/x.jsonl", last_activity_at: 1 }, 1);
    expect(store.getTailInfo("s1")).toEqual({ transcript_path: "/tmp/x.jsonl", usage_offset: 0 });
    store.setUsageOffset("s1", 42);
    expect(store.getTailInfo("s1")!.usage_offset).toBe(42);
    expect(store.getTailInfo("nope")).toBeNull();
  });

  it("lists only non-ended sessions with a transcript for tailing", () => {
    store.applyEvent("live", { status: "working", transcript_path: "/tmp/a.jsonl", last_activity_at: 1 }, 1);
    store.applyEvent("dead", { status: "ended", transcript_path: "/tmp/b.jsonl", last_activity_at: 1 }, 1);
    store.applyEvent("notp", { status: "working", last_activity_at: 1 }, 1); // no transcript_path
    const ids = store.sessionsToTail().map((s) => s.id).sort();
    expect(ids).toEqual(["live"]);
  });

  it("aggregates per-session, live (non-ended), today, and per-model", () => {
    const MIDNIGHT = 2_000_000;
    // sessions: a = working (live), b = ended
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.applyEvent("b", { status: "ended", last_activity_at: 1 }, 1);
    // a: opus, one row before midnight + one after
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: MIDNIGHT - 1, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: MIDNIGHT + 1, cost: 2.0 });
    // b (ended): haiku, after midnight
    store.recordUsage({ uuid: "b1", sessionId: "b", model: "claude-haiku-4-5", tokens: tok(0), at: MIDNIGHT + 1, cost: 4.0 });

    const s = store.costSummary(MIDNIGHT);
    expect(s.perSession.a.costUsd).toBeCloseTo(3.0, 6); // 1.0 + 2.0 lifetime
    expect(s.perSession.b.costUsd).toBeCloseTo(4.0, 6);
    expect(s.liveTotalUsd).toBeCloseTo(3.0, 6); // only session a (b is ended)
    expect(s.todayUsd).toBeCloseTo(6.0, 6); // 2.0 (a2) + 4.0 (b1), excludes a1 (before midnight)
    expect(s.byModelToday).toEqual([
      { model: "claude-haiku-4-5", costUsd: 4.0 },
      { model: "claude-opus-4-8", costUsd: 2.0 },
    ]);
  });

  it("stamps the session's current project and branch onto the usage row", () => {
    store.applyEvent("s1", { status: "working", project: "acme", branch: "feat/x", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "m1", sessionId: "s1", model: "claude-opus-4-8", tokens: tok(10), at: 1000, cost: 0.5 });
    const row = store.db.query("SELECT project, branch FROM usage WHERE message_uuid = 'm1'").get();
    expect(row).toEqual({ project: "acme", branch: "feat/x" });
  });

  it("stamps a null branch when the session is on no branch", () => {
    store.applyEvent("s2", { status: "working", project: "acme", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "m2", sessionId: "s2", model: "claude-opus-4-8", tokens: tok(10), at: 1000, cost: 0.5 });
    const row = store.db.query("SELECT project, branch FROM usage WHERE message_uuid = 'm2'").get();
    expect(row).toEqual({ project: "acme", branch: null });
  });

  it("aggregates cost and tokens by project, highest first", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.applyEvent("b", { status: "working", project: "beta", branch: "main", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: 100, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: 200, cost: 2.0 });
    store.recordUsage({ uuid: "b1", sessionId: "b", model: "claude-opus-4-8", tokens: tok(5), at: 100, cost: 0.5 });
    expect(store.costByProject()).toEqual([
      { project: "alpha", costUsd: 3.0, tokens: 20 },
      { project: "beta", costUsd: 0.5, tokens: 5 },
    ]);
  });

  it("filters costByProject by time range (since inclusive, until exclusive)", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 200, cost: 2.0 });
    store.recordUsage({ uuid: "a3", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 300, cost: 4.0 });
    expect(store.costByProject({ since: 200, until: 300 })).toEqual([{ project: "alpha", costUsd: 2.0, tokens: 0 }]);
  });

  it("buckets usage with no resolvable project under 'unknown'", () => {
    // usage for a session row that doesn't exist → project stamps NULL
    store.recordUsage({ uuid: "x1", sessionId: "ghost", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costByProject()).toEqual([{ project: "unknown", costUsd: 1.0, tokens: 0 }]);
  });

  it("aggregates costByBranch by (project, branch) so same-named branches don't merge across repos", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.applyEvent("b", { status: "working", project: "beta", branch: "main", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: 100, cost: 1.0 });
    store.recordUsage({ uuid: "b1", sessionId: "b", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 2.0 });
    expect(store.costByBranch()).toEqual([
      { project: "beta", branch: "main", costUsd: 2.0, tokens: 0 },
      { project: "alpha", branch: "main", costUsd: 1.0, tokens: 10 },
    ]);
  });

  it("preserves a null branch in costByBranch", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1); // no branch
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costByBranch()).toEqual([{ project: "alpha", branch: null, costUsd: 1.0, tokens: 0 }]);
  });

  it("sums all token types into perSession.tokens", () => {
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({
      uuid: "a1", sessionId: "a", model: "claude-opus-4-8",
      tokens: { input: 10, output: 20, cache_read: 30, cache_create_5m: 5, cache_create_1h: 5 },
      at: 1, cost: 0,
    });
    expect(store.costSummary(0).perSession.a.tokens).toBe(70);
  });

  it("groups cost + tokens by (project, branch, local day)", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    // two rows on the SAME instant (same day) + one 26h later (a different
    // calendar day in ANY timezone, DST included).
    store.recordUsage({ uuid: "d1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: T, cost: 1.0 });
    store.recordUsage({ uuid: "d2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T, cost: 2.0 });
    store.recordUsage({ uuid: "d3", sessionId: "a", model: "claude-opus-4-8", tokens: tok(5), at: T + 26 * 3600 * 1000, cost: 4.0 });

    const rows = store.costDaily();
    expect(rows.length).toBe(2); // two distinct local days for alpha·main
    for (const r of rows) {
      expect(r.project).toBe("alpha");
      expect(r.branch).toBe("main");
      expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const days = new Set(rows.map((r) => r.day));
    expect(days.size).toBe(2); // the two days differ
    const sameDay = rows.find((r) => r.costUsd === 3.0); // 1.0 + 2.0 merged
    expect(sameDay).toBeTruthy();
    expect(sameDay!.tokens).toBe(10);
  });

  it("costDaily filters by time range (since inclusive, until exclusive)", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    store.recordUsage({ uuid: "r1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T, cost: 1.0 });
    store.recordUsage({ uuid: "r2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T + 26 * 3600 * 1000, cost: 2.0 });
    const rows = store.costDaily({ since: T + 1 }); // excludes r1
    expect(rows.length).toBe(1);
    expect(rows[0].costUsd).toBeCloseTo(2.0, 6);
  });

  it("costDaily buckets unattributed usage under 'unknown' and keeps null branch", () => {
    // usage for a session row that doesn't exist → project/branch stamp NULL
    store.recordUsage({ uuid: "g1", sessionId: "ghost", model: "claude-opus-4-8", tokens: tok(0), at: 1_700_000_000_000, cost: 1.0 });
    const rows = store.costDaily();
    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe("unknown");
    expect(rows[0].branch).toBeNull();
  });
});
