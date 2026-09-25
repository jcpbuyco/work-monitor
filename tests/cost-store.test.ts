import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import type { Tokens } from "../src/server/pricing.ts";
import { WF_QUIET_MS } from "../src/server/config.ts";

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
    expect(store.getTailInfo("s1")).toEqual({
      transcript_path: "/tmp/x.jsonl",
      usage_offset: 0,
      harness: "claude",
      model: null,
    });
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

  it("keeps an unknown-today model visible in byModelToday with costUsd: null, instead of a HAVING c > 0 filter dropping it (§2.3)", () => {
    const MIDNIGHT = 2_000_000;
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "totally-unknown-model", tokens: tok(5), at: MIDNIGHT + 1, cost: null });
    const s = store.costSummary(MIDNIGHT);
    expect(s.byModelToday).toEqual([{ model: "totally-unknown-model", costUsd: null }]);
    // The whole day's total is null too -- SUM(cost_usd) over an all-NULL
    // group, never coalesced to a fabricated $0.00 (§2.3, finding).
    expect(s.todayUsd).toBeNull();
  });

  it("costSummary reports unpricedTokens/unpricedModels for an unknown model, all-time (§2.3)", () => {
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: 1, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "totally-unknown-model", tokens: tok(7), at: 1, cost: null });
    const s = store.costSummary(0);
    expect(s.unpricedTokens).toBe(7);
    expect(s.unpricedModels).toEqual([{ model: "totally-unknown-model", tokens: 7 }]);
    // The priced row is unaffected -- unpriced usage is additional information,
    // never something that shrinks or masks the known total.
    expect(s.perSession.a.costUsd).toBeCloseTo(1.0, 6);
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
      { project: "alpha", costUsd: 3.0, tokens: 20, unpricedTokens: 0 },
      { project: "beta", costUsd: 0.5, tokens: 5, unpricedTokens: 0 },
    ]);
  });

  it("filters costByProject by time range (since inclusive, until exclusive)", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 200, cost: 2.0 });
    store.recordUsage({ uuid: "a3", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 300, cost: 4.0 });
    expect(store.costByProject({ since: 200, until: 300 })).toEqual([
      { project: "alpha", costUsd: 2.0, tokens: 0, unpricedTokens: 0 },
    ]);
  });

  it("buckets usage with no resolvable project under 'unknown'", () => {
    // usage for a session row that doesn't exist → project stamps NULL
    store.recordUsage({ uuid: "x1", sessionId: "ghost", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costByProject()).toEqual([{ project: "unknown", costUsd: 1.0, tokens: 0, unpricedTokens: 0 }]);
  });

  it("costByProject surfaces unpricedTokens instead of silently shrinking the total when a project mixes priced and unpriced usage", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: 100, cost: 1.0 });
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "totally-unknown-model", tokens: tok(7), at: 100, cost: null });
    expect(store.costByProject()).toEqual([{ project: "alpha", costUsd: 1.0, tokens: 17, unpricedTokens: 7 }]);
  });

  it("costByProject returns costUsd: null (not $0.00) plus unpricedTokens when a project's usage is ENTIRELY unpriced", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "totally-unknown-model", tokens: tok(9), at: 100, cost: null });
    expect(store.costByProject()).toEqual([{ project: "alpha", costUsd: null, tokens: 9, unpricedTokens: 9 }]);
  });

  it("aggregates costByBranch by (project, branch) so same-named branches don't merge across repos", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.applyEvent("b", { status: "working", project: "beta", branch: "main", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: 100, cost: 1.0 });
    store.recordUsage({ uuid: "b1", sessionId: "b", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 2.0 });
    expect(store.costByBranch()).toEqual([
      { project: "beta", branch: "main", costUsd: 2.0, tokens: 0, unpricedTokens: 0 },
      { project: "alpha", branch: "main", costUsd: 1.0, tokens: 10, unpricedTokens: 0 },
    ]);
  });

  it("preserves a null branch in costByBranch", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1); // no branch
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costByBranch()).toEqual([{ project: "alpha", branch: null, costUsd: 1.0, tokens: 0, unpricedTokens: 0 }]);
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

  it("costDaily surfaces unpricedTokens per day instead of silently shrinking the total", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    store.recordUsage({ uuid: "d1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(10), at: T, cost: 1.0 });
    store.recordUsage({ uuid: "d2", sessionId: "a", model: "totally-unknown-model", tokens: tok(4), at: T, cost: null });
    const rows = store.costDaily();
    expect(rows).toEqual([{ project: "alpha", branch: "main", day: rows[0].day, costUsd: 1.0, tokens: 14, unpricedTokens: 4 }]);
  });

  it("costDaily buckets unattributed usage under 'unknown' and keeps null branch", () => {
    // usage for a session row that doesn't exist → project/branch stamp NULL
    store.recordUsage({ uuid: "g1", sessionId: "ghost", model: "claude-opus-4-8", tokens: tok(0), at: 1_700_000_000_000, cost: 1.0 });
    const rows = store.costDaily();
    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe("unknown");
    expect(rows[0].branch).toBeNull();
  });

  it("memoizes costByProject/costByBranch on usageVersion: a duplicate recordUsage (no-op) does not invalidate a stale query plan, and a real write does", () => {
    store.applyEvent("a", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    const first = store.costByProject();
    expect(first).toEqual([{ project: "alpha", costUsd: 1.0, tokens: 0, unpricedTokens: 0 }]);

    // A duplicate uuid is INSERT OR IGNORE'd -- must not bump usageVersion, so
    // the cached result (a fresh object built by that first call) is reused.
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costByProject()).toBe(first); // same array reference: served from cache

    // A genuinely new row must invalidate the cache and be reflected.
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 2.0 });
    const second = store.costByProject();
    expect(second).not.toBe(first);
    expect(second).toEqual([{ project: "alpha", costUsd: 3.0, tokens: 0, unpricedTokens: 0 }]);
  });

  it("bumpUsageVersion invalidates the memoized cost caches for a usage write that bypassed recordUsage", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    const first = store.costByProject();

    // A write that bypasses recordUsage (e.g. reprice.ts's raw DELETE, or a
    // future generic-reprice/dedupe migration) must not silently invalidate
    // itself -- the cache is stale until the caller explicitly bumps it.
    store.db.query(`UPDATE usage SET cost_usd = 5.0 WHERE message_uuid = 'a1'`).run();
    expect(store.costByProject()).toBe(first); // still served from cache

    store.bumpUsageVersion();
    const second = store.costByProject();
    expect(second).not.toBe(first);
    expect(second).toEqual([{ project: "alpha", costUsd: 5.0, tokens: 0, unpricedTokens: 0 }]);
  });

  it("a ranged costByProject call is never cached and always reflects the latest write", () => {
    store.applyEvent("a", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costByProject({ since: 0 })).toEqual([{ project: "alpha", costUsd: 1.0, tokens: 0, unpricedTokens: 0 }]);
    store.recordUsage({ uuid: "a2", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 5.0 });
    expect(store.costByProject({ since: 0 })).toEqual([{ project: "alpha", costUsd: 6.0, tokens: 0, unpricedTokens: 0 }]);
  });

  it("costSummary's live total reflects a session ending even with no new usage write (never memoized on usageVersion alone)", () => {
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: 100, cost: 1.0 });
    expect(store.costSummary(0).liveTotalUsd).toBeCloseTo(1.0, 6);
    store.applyEvent("a", { status: "ended", ended_at: 2 }, 2); // no usage write here
    expect(store.costSummary(0).liveTotalUsd).toBeCloseTo(0, 6);
  });

  it("costSummary's today block is keyed on the day boundary too, not usageVersion alone", () => {
    store.applyEvent("a", { status: "working", last_activity_at: 1 }, 1);
    const T = 1_700_000_000_000;
    store.recordUsage({ uuid: "a1", sessionId: "a", model: "claude-opus-4-8", tokens: tok(0), at: T, cost: 1.0 });
    expect(store.costSummary(T - 1).todayUsd).toBeCloseTo(1.0, 6); // midnight before the row -> included
    // A later "midnight" excludes the row entirely -- SUM() over zero matching
    // rows is NULL, not a fabricated $0.00 (§2.3); distinct cache entry either way.
    expect(store.costSummary(T + 1).todayUsd).toBeNull();
  });

  it("records run_id and agent_id when given, NULL when not", () => {
    store.recordUsage({ uuid: "w1", sessionId: "s1", model: "claude-opus-5", tokens: tok(10), at: 1, cost: 1, runId: "wf_1", agentId: "a1" });
    store.recordUsage({ uuid: "p1", sessionId: "s1", model: "claude-opus-5", tokens: tok(10), at: 1, cost: 1 });
    const rows = store.db.query("SELECT message_uuid, run_id, agent_id FROM usage ORDER BY message_uuid").all();
    expect(rows).toEqual([
      { message_uuid: "p1", run_id: null, agent_id: null },
      { message_uuid: "w1", run_id: "wf_1", agent_id: "a1" },
    ]);
  });

  /** A run with two agents: a1 cost $3 / 30 tok, a2 cost $1 / 10 tok. */
  function seedRun(store: Store, runId: string, startedAt: number) {
    store.applyEvent("p", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({
      run_id: runId, session_id: "p", dir: `/d/${runId}`, name: "research", status: "completed",
      manifest_seen: true, last_seen_at: startedAt, started_at: startedAt, duration_ms: 1234,
      agent_count: 2, total_tokens_reported: 99,
      phases: JSON.stringify([{ title: "Explore", detail: "d" }, { title: "Judge", detail: null }]),
    });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a1", label: "map", phase_index: 1, phase_title: "Explore", state: "done" });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a2", label: "judge", phase_index: 2, phase_title: "Judge", state: "abandoned" });
    store.recordUsage({ uuid: `${runId}-1`, sessionId: "p", model: "claude-opus-5", tokens: tok(30), at: startedAt, cost: 3, runId, agentId: "a1" });
    store.recordUsage({ uuid: `${runId}-2`, sessionId: "p", model: "claude-opus-5", tokens: tok(10), at: startedAt, cost: 1, runId, agentId: "a2" });
  }

  it("workflowHistory embeds agents with their usage rollups and a run total", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    const runs = store.workflowHistory({}, T + 60 * 60 * 1000);
    expect(runs.length).toBe(1);
    const r = runs[0];
    expect(r.costUsd).toBeCloseTo(4, 6);
    expect(r.tokens).toBe(40);
    expect(r.project).toBe("alpha");
    expect(r.phases).toEqual([{ title: "Explore", detail: "d" }, { title: "Judge", detail: null }]);
    expect(r.schema_ok).toBe(true);
    expect(r.agents.map((a) => a.agent_id).sort()).toEqual(["a1", "a2"]);
    const a1 = r.agents.find((a) => a.agent_id === "a1")!;
    expect(a1.costUsd).toBeCloseTo(3, 6);
    expect(a1.tokens).toBe(30);
    expect(a1.phase_title).toBe("Explore");
  });

  it("workflowHistory never turns an unpriced agent's cost into a fabricated $0.00 (§2.3, finding)", () => {
    const T = 1_700_000_000_000;
    store.applyEvent("p", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_u", session_id: "p", dir: "/d/wf_u", status: "running", started_at: T });
    store.upsertWorkflowAgent({ run_id: "wf_u", agent_id: "u1", state: "running" });
    store.upsertWorkflowAgent({ run_id: "wf_u", agent_id: "u2", state: "running" });
    // u1 is entirely unpriced (unknown model); u2 is normally priced.
    store.recordUsage({ uuid: "wf_u-1", sessionId: "p", model: "totally-unknown-model", tokens: tok(8), at: T, cost: null, runId: "wf_u", agentId: "u1" });
    store.recordUsage({ uuid: "wf_u-2", sessionId: "p", model: "claude-opus-5", tokens: tok(30), at: T, cost: 3, runId: "wf_u", agentId: "u2" });

    const r = store.workflowHistory({}, T + 1000)[0];
    const u1 = r.agents.find((a) => a.agent_id === "u1")!;
    const u2 = r.agents.find((a) => a.agent_id === "u2")!;
    expect(u1.costUsd).toBeNull(); // not a fabricated $0.00
    expect(u1.unpricedTokens).toBe(8);
    expect(u2.costUsd).toBeCloseTo(3, 6);
    expect(u2.unpricedTokens).toBe(0);
    // The run total is the KNOWN partial sum (u2's $3), not null and not $0 --
    // u1's unknown portion is visible separately via the run's unpricedTokens.
    expect(r.costUsd).toBeCloseTo(3, 6);
    expect(r.unpricedTokens).toBe(8);
  });

  it("workflowHistory derives run state from liveness, not from the stored status", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    expect(store.workflowHistory({}, T + 60 * 60 * 1000)[0].state).toBe("settled");
    expect(store.workflowHistory({}, T + 1000)[0].state).toBe("running"); // dir still warm
  });

  it("workflowHistory filters on started_at (since inclusive, until exclusive) and drops NULL starts when bounded", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    seedRun(store, "wf_b", T + 5000);
    store.upsertWorkflowRun({ run_id: "wf_null", session_id: "p", dir: "/d/n" }); // started_at NULL
    expect(store.workflowHistory({}, T).map((r) => r.run_id)).toContain("wf_null"); // unbounded includes it
    expect(store.workflowHistory({ since: T + 1 }, T).map((r) => r.run_id)).toEqual(["wf_b"]);
    expect(store.workflowHistory({ until: T + 1 }, T).map((r) => r.run_id)).toEqual(["wf_a"]);
  });

  it("workflowHistory orders newest-first and clamps limit to 1..500", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_a", T);
    seedRun(store, "wf_b", T + 5000);
    expect(store.workflowHistory({}, T).map((r) => r.run_id)).toEqual(["wf_b", "wf_a"]);
    expect(store.workflowHistory({ limit: 1 }, T).map((r) => r.run_id)).toEqual(["wf_b"]); // limit caps RUNS
    expect(store.workflowHistory({ limit: 0 }, T).length).toBe(1); // clamped up to 1
    expect(store.workflowHistory({ limit: 99999 }, T).length).toBe(2); // clamped down to 500
  });

  it("workflowHistory buckets a run with no resolvable project under 'unknown' and yields 0s with no usage", () => {
    store.upsertWorkflowRun({ run_id: "wf_ghost", session_id: "ghost", dir: "/d/g", started_at: 1 });
    const r = store.workflowHistory({}, 2)[0];
    expect(r.project).toBe("unknown");
    expect(r.costUsd).toBe(0);
    expect(r.tokens).toBe(0);
    expect(r.agents).toEqual([]);
  });

  it("liveWorkflows returns unsettled runs only, with rollups and a 1-based phase pill", () => {
    const T = 1_700_000_000_000;
    seedRun(store, "wf_live", T);
    // Warm dir -> running; the same run an hour later is settled and drops out.
    const live = store.liveWorkflows(T + 1000);
    expect(live.length).toBe(1);
    expect(live[0].run_id).toBe("wf_live");
    expect(live[0].state).toBe("running");
    expect(live[0].costUsd).toBeCloseTo(4, 6);
    expect(live[0].tokens).toBe(40);
    expect(live[0].agents.length).toBe(2);
    // phases.length is 2 and the highest agent phase_index is 2 -> "Phase 2/2 · Judge"
    expect(live[0].phase).toEqual({ index: 2, total: 2, title: "Judge" });
    expect(store.liveWorkflows(T + 60 * 60 * 1000)).toEqual([]);
  });

  it("liveWorkflows keeps an orphaned run visible and reports phase: null with no phases", () => {
    store.upsertWorkflowRun({ run_id: "wf_orph", session_id: "ghost", dir: "/d/o", started_at: 1000, last_seen_at: 1000 });
    const live = store.liveWorkflows(2000);
    expect(live.length).toBe(1);
    expect(live[0].state).toBe("orphaned"); // no manifest, purged session
    expect(live[0].phase).toBeNull();
    expect(live[0].project).toBe("unknown"); // COALESCE, matching costByProject
  });

  it("liveWorkflows drops runs older than the 24h recheck window", () => {
    store.upsertWorkflowRun({ run_id: "wf_ancient", session_id: "p", dir: "/d/a", started_at: 1, last_seen_at: 1 });
    expect(store.liveWorkflows(1 + 25 * 60 * 60 * 1000)).toEqual([]);
  });

  it("§3: normalises a left-behind progress/running agent to killed when the RUN's own status is killed or failed", () => {
    const T = 1_700_000_000_000;
    store.applyEvent("p", { status: "working", project: "alpha", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_k", session_id: "p", dir: "/d/wf_k", status: "killed", manifest_seen: true, last_seen_at: T, started_at: T });
    store.upsertWorkflowAgent({ run_id: "wf_k", agent_id: "a1", state: "progress" });
    store.upsertWorkflowAgent({ run_id: "wf_k", agent_id: "a2", state: "running" });
    store.upsertWorkflowAgent({ run_id: "wf_k", agent_id: "a3", state: "error" }); // untouched
    store.upsertWorkflowAgent({ run_id: "wf_k", agent_id: "a4", state: "done" }); // untouched
    const r = store.workflowHistory({}, T + 60 * 60 * 1000)[0];
    const stateOf = (id: string) => r.agents.find((a) => a.agent_id === id)!.state;
    expect(stateOf("a1")).toBe("killed");
    expect(stateOf("a2")).toBe("killed");
    expect(stateOf("a3")).toBe("error"); // manifest error state stays error
    expect(stateOf("a4")).toBe("done");
  });

  it("§3 spec-gap fix (C6): leaves progress/running agents alone while the run itself still reads running, even if status says killed/failed", () => {
    // wf_3b398ae6-146: a manifest says `failed` while agent transcripts are
    // still actively appending, then gets rewritten to `completed` minutes
    // later. During that window the run's DERIVED state is "running" (the dir
    // is still moving), and normalizing its agents to killed would show
    // provably-still-working agents as dead.
    const T = 1_700_000_000_000;
    store.applyEvent("p", { status: "working", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_c6", session_id: "p", dir: "/d/wf_c6", status: "failed", manifest_seen: true, last_seen_at: T, started_at: T });
    store.upsertWorkflowAgent({ run_id: "wf_c6", agent_id: "a1", state: "progress" });
    const r = store.workflowHistory({}, T + 1000)[0]; // 1s later: nowhere near WF_QUIET_MS -> still "running"
    expect(r.state).toBe("running");
    expect(r.agents[0].state).toBe("progress"); // NOT normalized to killed while still running
  });

  it("§3: leaves progress/running agents alone when the run itself is not killed/failed", () => {
    const T = 1_700_000_000_000;
    store.applyEvent("p", { status: "working", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_ok", session_id: "p", dir: "/d/wf_ok", status: "completed", manifest_seen: true, last_seen_at: T, started_at: T });
    store.upsertWorkflowAgent({ run_id: "wf_ok", agent_id: "a1", state: "running" });
    const r = store.workflowHistory({}, T + 60 * 60 * 1000)[0];
    expect(r.agents[0].state).toBe("running");
  });

  it("§3: a running run reports a LIVE duration_ms (now - started_at), not a stale/absent stored one", () => {
    const T = 1_700_000_000_000;
    store.applyEvent("p", { status: "working", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({ run_id: "wf_live", session_id: "p", dir: "/d/l", started_at: T, last_seen_at: T, duration_ms: 1234 });
    const r = store.workflowHistory({}, T + 5000)[0];
    expect(r.state).toBe("running");
    expect(r.duration_ms).toBe(5000); // live elapsed, not the stale stored 1234
  });

  it("§3: persists and surfaces the manifest's own defaultModel/totalToolCalls", () => {
    store.upsertWorkflowRun({ run_id: "wf_dm", session_id: "p", dir: "/d/dm", started_at: 1, default_model: "claude-fable-5-1", total_tool_calls: 42 });
    const r = store.workflowHistory({}, 2)[0];
    expect(r.default_model).toBe("claude-fable-5-1");
    expect(r.total_tool_calls).toBe(42);
  });
});

describe("Store §3: workflowList / workflowRunDetail / lastSettledRun", () => {
  let store: Store;
  const T = 1_700_000_000_000;
  beforeEach(() => {
    store = new Store(openDb(":memory:"));
  });

  function seedRun(runId: string, startedAt: number, over: Partial<Parameters<Store["upsertWorkflowRun"]>[0]> = {}) {
    store.applyEvent("p", { status: "working", project: "alpha", branch: "main", last_activity_at: 1 }, 1);
    store.upsertWorkflowRun({
      run_id: runId, session_id: "p", dir: `/d/${runId}`, name: "research", status: "completed",
      manifest_seen: true, last_seen_at: startedAt, started_at: startedAt, ...over,
    });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a1", state: "done" });
    store.upsertWorkflowAgent({ run_id: runId, agent_id: "a2", state: "error" });
    store.recordUsage({ uuid: `${runId}-1`, sessionId: "p", model: "claude-opus-5", tokens: tok(30), at: startedAt, cost: 3, runId, agentId: "a1" });
  }

  it("workflowList returns runs WITHOUT agents, with an agent_counts rollup and a total", () => {
    seedRun("wf_a", T);
    const { runs, total } = store.workflowList({}, T + 60 * 60 * 1000);
    expect(total).toBe(1);
    expect(runs.length).toBe(1);
    expect((runs[0] as any).agents).toBeUndefined();
    expect(runs[0].agent_counts).toEqual({ total: 2, done: 1, error: 1, running: 0, abandoned: 0, killed: 0 });
    expect(runs[0].costUsd).toBeCloseTo(3, 6);
  });

  it("workflowList's total counts the whole match, independent of limit/offset", () => {
    seedRun("wf_a", T);
    seedRun("wf_b", T + 1000);
    seedRun("wf_c", T + 2000);
    const page = store.workflowList({ limit: 1, offset: 1 }, T + 60 * 60 * 1000);
    expect(page.total).toBe(3);
    expect(page.runs.map((r) => r.run_id)).toEqual(["wf_b"]); // newest-first: c, b, a
  });

  it("workflowList's q matches a case-insensitive substring of name or project", () => {
    seedRun("wf_a", T);
    expect(store.workflowList({ q: "resea" }, T).runs.map((r) => r.run_id)).toEqual(["wf_a"]);
    expect(store.workflowList({ q: "ALPHA" }, T).runs.map((r) => r.run_id)).toEqual(["wf_a"]);
    expect(store.workflowList({ q: "nonesuch" }, T).runs).toEqual([]);
  });

  it("workflowRunDetail returns one run WITH its agents, or null for an unknown run", () => {
    seedRun("wf_a", T);
    const run = store.workflowRunDetail("wf_a", T + 60 * 60 * 1000)!;
    expect(run.run_id).toBe("wf_a");
    expect(run.agents.map((a) => a.agent_id).sort()).toEqual(["a1", "a2"]);
    expect(store.workflowRunDetail("nope")).toBeNull();
  });

  it("lastSettledRun returns the most recently-ended run that actually reads settled", () => {
    seedRun("wf_older", T, { ended_at: T + 100 });
    seedRun("wf_newer", T + 1000, { ended_at: T + 1100 });
    const last = store.lastSettledRun(T + 60 * 60 * 1000)!;
    expect(last.run_id).toBe("wf_newer");
    expect(last.name).toBe("research");
    expect(last.status).toBe("completed");
    expect(last.costUsd).toBeCloseTo(3, 6);
  });

  it("lastSettledRun skips a more-recent run that is still running (dir still warm) in favour of an older settled one", () => {
    seedRun("wf_settled", T, { ended_at: T + 100 });
    // last_seen_at = started_at = T + 5000 -- recent enough, relative to `now`
    // below, to still read "running" (quiet needs a full WF_QUIET_MS of silence).
    seedRun("wf_still_live", T + 5000, { ended_at: T + 5100 });
    const now = T + WF_QUIET_MS + 1000; // wf_settled is quiet by now; wf_still_live isn't yet
    expect(store.liveWorkflows(now).map((r) => r.run_id)).toEqual(["wf_still_live"]); // sanity
    expect(store.lastSettledRun(now)!.run_id).toBe("wf_settled");
  });

  it("lastSettledRun returns null when there are no runs at all", () => {
    expect(store.lastSettledRun(T)).toBeNull();
  });

  it("finds a settled run even behind 25 more-recent still-running ones (spec gap: no arbitrary top-N cap)", () => {
    seedRun("wf_settled_old", T, { ended_at: T + 100 });
    const now = T + WF_QUIET_MS + 5000;
    for (let i = 0; i < 25; i++) {
      // Newer by end time, but freshly "seen" -- still running relative to `now`.
      seedRun(`wf_running_${i}`, now - 1000, { ended_at: now + 100_000 });
    }
    expect(store.lastSettledRun(now)!.run_id).toBe("wf_settled_old");
  });
});
