import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { repriceFiveSeries, REPRICE_MARKER } from "../src/server/reprice.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (input: number): Tokens => ({ input, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });

/** One transcript line worth exactly $5 at the opus tier (1M input tokens). */
function line(uuid: string, model = "claude-opus-5") {
  return (
    JSON.stringify({
      uuid,
      timestamp: "2026-08-01T08:00:00.000Z",
      message: { model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }) + "\n"
  );
}

function fixture(): { store: Store; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "am-reprice-"));
  const file = join(dir, "t.jsonl");
  writeFileSync(file, line("m1") + line("m2"));
  const store = new Store(openDb(":memory:"));
  // An ENDED session — sessionsToTail() would never touch it, which is exactly
  // why the routine must re-tail in-process (spec §0b step 5).
  store.applyEvent("s1", { status: "ended", project: "alpha", branch: "main", transcript_path: file, last_activity_at: 1 }, 1);
  store.setUsageOffset("s1", 999);
  // The pre-existing damage: rows recorded at $0 before the rates were added.
  store.recordUsage({ uuid: "m1", sessionId: "s1", model: "claude-opus-5", tokens: tok(1_000_000), at: 1, cost: 0 });
  store.recordUsage({ uuid: "m2", sessionId: "s1", model: "claude-opus-5", tokens: tok(1_000_000), at: 1, cost: 0 });
  return { store, file };
}

describe("repriceFiveSeries", () => {
  it("deletes the $0 5-series rows and re-tails them back at the correct price", () => {
    const { store } = fixture();
    expect(store.costSummary(0).perSession.s1.costUsd).toBe(0);

    const r = repriceFiveSeries(store, 5000);
    expect(r.sessions).toBe(1);
    expect(r.deleted).toBe(2);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // 2 × $5
  });

  it("leaves legitimately-free rows of other models untouched", () => {
    const { store } = fixture();
    store.recordUsage({ uuid: "syn", sessionId: "s1", model: "<synthetic>", tokens: tok(0), at: 1, cost: 0 });
    repriceFiveSeries(store, 5000);
    const kept = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE model = '<synthetic>'").get() as { c: number };
    expect(kept.c).toBe(1);
  });

  it("skips sessions whose transcript is gone rather than deleting their history", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("ghost", { status: "ended", transcript_path: "/no/such/file.jsonl", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "g1", sessionId: "ghost", model: "claude-opus-5", tokens: tok(10), at: 1, cost: 0 });
    const r = repriceFiveSeries(store, 5000);
    expect(r.sessions).toBe(0);
    expect(r.deleted).toBe(0);
    const still = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE message_uuid = 'g1'").get() as { c: number };
    expect(still.c).toBe(1); // token history preserved
  });

  it("writes a marker so a restart cannot re-run it", () => {
    const { store } = fixture();
    repriceFiveSeries(store, 5000);
    expect(store.getMeta(REPRICE_MARKER)).toBe("5000");
  });
});
