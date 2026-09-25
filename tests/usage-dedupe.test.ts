import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { dedupeHistoricUsage, USAGE_DEDUPE_MARKER } from "../src/server/usage-dedupe.ts";
import { BACKUP_MARKER } from "../src/server/retention.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (input: number, cacheRead = 0): Tokens => ({
  input,
  output: 0,
  cache_read: cacheRead,
  cache_create_5m: 0,
  cache_create_1h: 0,
});

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A group of 3 duplicate content-block lines of ONE historic API message
 *  (identical input/cache, growing then plateauing output -- real shape, see
 *  tests/fixtures/usage/multi-line-message.jsonl), recorded BEFORE message_key
 *  existed, so they were never collapsed at ingest. */
function seedDuplicateGroup(store: Store) {
  store.applyEvent("s1", { status: "ended", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
  store.recordUsage({ uuid: "d1", sessionId: "s1", model: "claude-fable-5", tokens: tok(2, 28346), at: 100, cost: 0.5 });
  store.recordUsage({ uuid: "d2", sessionId: "s1", model: "claude-fable-5", tokens: tok(2, 28346), at: 101, cost: 6.0 });
  store.recordUsage({ uuid: "d3", sessionId: "s1", model: "claude-fable-5", tokens: tok(2, 28346), at: 102, cost: 6.0 });
  // Manually raise output on the later two lines the way a real streaming
  // response would -- recordUsage's own message_key upsert is a separate code
  // path (§2.2 ingest-time dedup); this migration exists for rows that were
  // already 3 separate DB rows before that path existed.
  store.db.query("UPDATE usage SET output_tokens = 2 WHERE message_uuid = 'd1'").run();
  store.db.query("UPDATE usage SET output_tokens = 855 WHERE message_uuid = 'd2'").run();
  store.db.query("UPDATE usage SET output_tokens = 855 WHERE message_uuid = 'd3'").run();
}

describe("dedupeHistoricUsage", () => {
  it("collapses a duplicate group to its earliest row, with output_tokens raised to the group max", () => {
    const store = new Store(openDb(":memory:"));
    seedDuplicateGroup(store);
    const r = dedupeHistoricUsage(store, ":memory:", 5000);
    expect(r).toEqual({ before: 3, after: 1, deleted: 2, groups: 1, beforeCostUsd: 12.5, afterCostUsd: 0.5 });

    const rows = store.db.query("SELECT message_uuid, output_tokens FROM usage").all();
    expect(rows).toEqual([{ message_uuid: "d1", output_tokens: 855 }]); // earliest uuid kept, output raised
  });

  it("deletes legacy <synthetic> rows outright -- the spec says they produce no row (§2.1/§2.2)", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    // A pre-existing row from before usage.ts started skipping <synthetic> at
    // ingest -- exactly what a DB migrated from an older build still has.
    store.recordUsage({ uuid: "syn1", sessionId: "s1", model: "<synthetic>", tokens: tok(0), at: 1, cost: 0 });
    store.recordUsage({ uuid: "real", sessionId: "s1", model: "claude-opus-5", tokens: tok(5), at: 1, cost: 1 });
    const r = dedupeHistoricUsage(store, ":memory:", 5000);
    expect(r.deleted).toBe(1);
    expect(r.groups).toBe(0); // not counted as a "duplicate group" -- deleted outright, never grouped
    const synthetic = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE model = '<synthetic>'").get() as { c: number };
    expect(synthetic.c).toBe(0);
    const real = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE message_uuid = 'real'").get() as { c: number };
    expect(real.c).toBe(1);
  });

  it("leaves rows in different groups (different session/model/tokens) untouched", () => {
    const store = new Store(openDb(":memory:"));
    seedDuplicateGroup(store);
    store.applyEvent("s2", { status: "working", project: "beta", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "solo", sessionId: "s2", model: "claude-opus-5", tokens: tok(5), at: 200, cost: 1 });
    const r = dedupeHistoricUsage(store, ":memory:", 5000);
    expect(r.deleted).toBe(2);
    const solo = store.db.query("SELECT COUNT(*) AS c FROM usage WHERE message_uuid = 'solo'").get() as { c: number };
    expect(solo.c).toBe(1);
  });

  it("groups by (session, agent, model, input/cache tokens) so different agents on the same run never merge", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("p", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "p", model: "claude-opus-5", tokens: tok(2), at: 1, cost: 1, agentId: "a1" });
    store.recordUsage({ uuid: "a2", sessionId: "p", model: "claude-opus-5", tokens: tok(2), at: 1, cost: 1, agentId: "a2" });
    const r = dedupeHistoricUsage(store, ":memory:", 5000);
    expect(r.deleted).toBe(0); // different agent_id -> different group, both kept
  });

  it("is guarded by a marker so a restart cannot re-run it", () => {
    const store = new Store(openDb(":memory:"));
    seedDuplicateGroup(store);
    dedupeHistoricUsage(store, ":memory:", 5000);
    expect(store.getMeta(USAGE_DEDUPE_MARKER)).toBe("5000");
    const again = dedupeHistoricUsage(store, ":memory:", 9999);
    expect(again).toEqual({ before: 0, after: 0, deleted: 0, groups: 0, beforeCostUsd: 0, afterCostUsd: 0 });
    expect(store.getMeta(USAGE_DEDUPE_MARKER)).toBe("5000"); // unchanged
  });

  it("bumps the cost-cache generation so a stale-warmed cost total reflects the collapse (§1.3)", () => {
    const store = new Store(openDb(":memory:"));
    seedDuplicateGroup(store);
    const stale = store.costByProject();
    // Row outputs are 2, 855, 855 (set by seedDuplicateGroup) -- all 3 rows counted.
    expect(stale[0].tokens).toBe((2 + 2 + 28346) + (2 + 855 + 28346) + (2 + 855 + 28346));
    dedupeHistoricUsage(store, ":memory:", 5000);
    const fresh = store.costByProject();
    expect(fresh).not.toBe(stale);
    expect(fresh[0].tokens).toBe(2 + 855 + 28346); // only the surviving row, output raised to the group max
  });

  it("runs the §1.4 backup before deleting anything, on a real file-backed DB", () => {
    dir = mkdtempSync(join(tmpdir(), "am-dedupe-"));
    const dbPath = join(dir, "am.sqlite");
    const store = new Store(openDb(dbPath));
    seedDuplicateGroup(store);
    const now = new Date("2026-09-25T00:00:00Z").getTime();
    dedupeHistoricUsage(store, dbPath, now);
    expect(store.getMeta(BACKUP_MARKER)).toBe(String(now));
    expect(existsSync(join(dir, "am-pre-multiharness-20260925.sqlite"))).toBe(true);
  });

  it("returns all-zero without touching app_meta writes twice when there is nothing to dedupe", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "u1", sessionId: "s1", model: "claude-opus-5", tokens: tok(5), at: 1, cost: 1 });
    const r = dedupeHistoricUsage(store, ":memory:", 5000);
    expect(r).toEqual({ before: 1, after: 1, deleted: 0, groups: 0, beforeCostUsd: 1, afterCostUsd: 1 });
    const row = store.db.query("SELECT COUNT(*) AS c FROM usage").get() as { c: number };
    expect(row.c).toBe(1);
  });
});
