import { describe, it, expect } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { repriceIfNeeded, RATES_VERSION_META_KEY } from "../src/server/reprice.ts";
import { RATES_VERSION } from "../src/server/pricing.ts";
import type { Tokens } from "../src/server/pricing.ts";

const tok = (input: number): Tokens => ({ input, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });

/** A store with rows recorded at $0 -- the state a stale/missing rate table
 *  leaves behind (the historical bug this module exists to fix, now handled
 *  generically instead of by a hardcoded model list). Tokens stay on the row
 *  regardless of price, so no transcript re-read is ever needed to recover it. */
function fixture(): Store {
  const store = new Store(openDb(":memory:"));
  store.applyEvent("s1", { status: "ended", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
  store.recordUsage({ uuid: "m1", sessionId: "s1", model: "claude-opus-5", tokens: tok(1_000_000), at: 1, cost: 0 });
  store.recordUsage({ uuid: "m2", sessionId: "s1", model: "claude-opus-5", tokens: tok(1_000_000), at: 1, cost: 0 });
  return store;
}

describe("repriceIfNeeded", () => {
  it("recomputes cost_usd for every row from its stored tokens and model, no transcript re-read needed", () => {
    const store = fixture();
    expect(store.costSummary(0).perSession.s1.costUsd).toBe(0);

    const r = repriceIfNeeded(store, 5000)!;
    expect(r.updated).toBe(2);
    expect(r.version).toBe(RATES_VERSION);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // 2 x $5 (opus-5 @ $5/MTok input)
  });

  it("writes the resolved rates_version to app_meta so a restart with unchanged rates is a no-op", () => {
    const store = fixture();
    repriceIfNeeded(store, 5000);
    expect(store.getMeta(RATES_VERSION_META_KEY)).toBe(RATES_VERSION);
    expect(repriceIfNeeded(store, 9999)).toBeNull(); // same version -> nothing to do
  });

  it("reprices EVERY model, not a hardcoded list -- including one that was previously $0/unpriced", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    // claude-fable-5-1 was missing from the old hardcoded RATES table entirely.
    store.recordUsage({ uuid: "f1", sessionId: "s1", model: "claude-fable-5-1", tokens: tok(1_000_000), at: 1, cost: 0 });
    repriceIfNeeded(store, 5000);
    expect(store.costSummary(0).perSession.s1.costUsd).toBeCloseTo(10, 6); // fable-5-1 @ $10/MTok input
  });

  it("writes cost_usd back to NULL for a genuinely unpriced model, never a stale or $0 value", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "u1", sessionId: "s1", model: "totally-unknown-model", tokens: tok(1_000_000), at: 1, cost: 0 });
    repriceIfNeeded(store, 5000);
    const row = store.db.query("SELECT cost_usd FROM usage WHERE message_uuid = 'u1'").get() as { cost_usd: number | null };
    expect(row.cost_usd).toBeNull();
  });

  it("prices a historic <synthetic> row (0 tokens) as unpriced, not a fabricated $0", () => {
    const store = new Store(openDb(":memory:"));
    store.applyEvent("s1", { status: "working", last_activity_at: 1 }, 1);
    // <synthetic> is skipped at ingest (§2.1) and never reaches recordUsage in
    // practice, but a pre-existing historic row of it (from before that guard
    // existed) must reprice to NULL like any other unknown model --
    // costOf("<synthetic>", ...) has no rate regardless of the tokens on the
    // row. (The one-time usage-dedupe migration deletes these rows outright;
    // this test documents reprice.ts's own behavior in isolation, in case one
    // somehow survives to reach it.)
    store.recordUsage({ uuid: "syn", sessionId: "s1", model: "<synthetic>", tokens: tok(0), at: 1, cost: 0 });
    repriceIfNeeded(store, 5000);
    const row = store.db.query("SELECT cost_usd FROM usage WHERE message_uuid = 'syn'").get() as { cost_usd: number | null };
    expect(row.cost_usd).toBeNull(); // unknown model, 0 tokens -> still unpriced, not a fabricated $0
  });

  it("bumps the cost-cache generation, so a costByProject() call warmed on the stale total reflects the repriced one (§1.3)", () => {
    const store = fixture();
    const stale = store.costByProject();
    expect(stale).toEqual([{ project: "alpha", costUsd: 0, tokens: 2_000_000, unpricedTokens: 0 }]);
    repriceIfNeeded(store, 5000);
    const fresh = store.costByProject();
    expect(fresh).not.toBe(stale);
    expect(fresh[0].costUsd).toBeCloseTo(10, 6); // 2 x $5, not the stale $0
  });

  it("is a no-op (returns null, no cache bump) when nothing needed pricing and the version already matches", () => {
    const store = new Store(openDb(":memory:"));
    repriceIfNeeded(store, 1000); // first call: empty usage table, still stamps the version
    const before = store.costByProject();
    expect(repriceIfNeeded(store, 2000)).toBeNull();
    expect(store.costByProject()).toBe(before); // cache untouched -- no spurious invalidation
  });
});
