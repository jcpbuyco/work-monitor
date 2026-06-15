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

  it("sums all token types into perSession.tokens", () => {
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({
      uuid: "a1", sessionId: "a", model: "claude-opus-4-8",
      tokens: { input: 10, output: 20, cache_read: 30, cache_create_5m: 5, cache_create_1h: 5 },
      at: 1, cost: 0,
    });
    expect(store.costSummary(0).perSession.a.tokens).toBe(70);
  });
});
