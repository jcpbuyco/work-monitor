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
});
