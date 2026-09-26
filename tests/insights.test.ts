import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import type { Tokens } from "../src/server/pricing.ts";
import {
  computeInsights,
  continuousMonths,
  kindOf,
  familyOf,
  tokenClassUsd,
  streaks,
  projection,
  samePointPrevMonth,
} from "../src/server/insights.ts";

// ---------------------------------------------------------------------------
// TZ canary (Insights spec §10): bun:sqlite's `'localtime'` modifier reads the
// process's timezone via the C library, which caches it at startup -- writing
// `process.env.TZ` from INSIDE a running test does not move it, even though
// plain JS `Date` getters (V8/ICU) pick the new value up immediately. The two
// engines must agree for every month/day bucket in this file. `bun test` also
// forces JS to UTC unless TZ is set, while SQLite keeps the system zone, so
// the repo's `.env.test` sets TZ before any test code runs (Bun loads it at
// startup), for `bun test tests/` and `bun run test` alike. If that file is
// removed, the second test below goes red.
// ---------------------------------------------------------------------------
describe("timezone: bun:sqlite 'localtime' vs JS Date", () => {
  it("a TZ write from inside the test does NOT move bun:sqlite's 'localtime' (documented limitation)", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14 -- as far from Berlin as it gets
      const db = new Database(":memory:");
      const at = 1_756_661_400_000; // a fixed instant
      const row = db.query("SELECT strftime('%Y-%m-%d %H:%M', $at/1000, 'unixepoch', 'localtime') AS s").get({ $at: at }) as {
        s: string;
      };
      // Whatever the process's REAL (start-time) timezone is, a runtime TZ
      // write must not have produced the UTC+14 answer -- proving the
      // in-process reassignment above was a no-op for SQLite specifically.
      expect(row.s).not.toBe("2025-09-01 05:30");
    } finally {
      // Assigning undefined would leave a bogus value behind for later tests.
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("with TZ pinned at startup (.env.test), SQLite 'localtime' and JS Date agree", () => {
    const db = new Database(":memory:");
    const at = 1_756_661_400_000;
    const row = db.query("SELECT strftime('%Y-%m-%d %H:%M', $at/1000, 'unixepoch', 'localtime') AS s").get({ $at: at }) as {
      s: string;
    };
    const d = new Date(at);
    const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
    const jsLocal = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    expect(row.s).toBe(jsLocal);
  });
});

const zeroTok: Tokens = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };

function freshStore(): Store {
  return new Store(openDb(":memory:"));
}

let seq = 0;
function usage(
  store: Store,
  opts: {
    sessionId?: string;
    project?: string;
    model: string;
    at: number;
    cost: number | null;
    tokens?: Partial<Tokens>;
    runId?: string;
    agentId?: string;
    harness?: string;
  }
): void {
  const sessionId = opts.sessionId ?? "s1";
  if (!store.getSession(sessionId)) {
    store.applyEvent(sessionId, { project: opts.project ?? "proj", status: "working", last_activity_at: opts.at }, opts.at);
  }
  const tokens: Tokens = { ...zeroTok, ...opts.tokens };
  store.recordUsage({
    uuid: `u${seq++}`,
    sessionId,
    model: opts.model,
    tokens,
    at: opts.at,
    cost: opts.cost,
    runId: opts.runId,
    agentId: opts.agentId,
    harness: opts.harness,
  });
}

/** Direct low-level row insert for the one case `recordUsage` cannot express:
 *  a truly NULL `usage.project` (recordUsage always stamps the session's own
 *  project, which defaults to the string `'unknown'`, never SQL NULL). */
function rawUsage(store: Store, opts: { sessionId: string; model: string; at: number; cost: number | null }): void {
  store.db
    .query(
      `INSERT INTO usage (message_uuid, session_id, model, input_tokens, output_tokens, cache_read_tokens,
         cache_create_5m_tokens, cache_create_1h_tokens, cost_usd, project, branch, at)
       VALUES ($u, $s, $m, 0, 0, 0, 0, 0, $cost, NULL, NULL, $at)`
    )
    .run({ $u: `raw${seq++}`, $s: opts.sessionId, $m: opts.model, $cost: opts.cost, $at: opts.at });
  store.bumpUsageVersion();
}

function localMs(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

describe("computeInsights: month/day bucketing", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("buckets a row just before local midnight into the earlier month, and just after into the next", () => {
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 8, 31, 23, 30), cost: 1 });
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 9, 1, 0, 10), cost: 2 });
    const r = computeInsights(store.db, localMs(2026, 9, 1, 12, 0));
    const aug = r.byMonthModel.find((m) => m.month === "2026-08" && m.model === "claude-sonnet-5");
    const sep = r.byMonthModel.find((m) => m.month === "2026-09" && m.model === "claude-sonnet-5");
    expect(aug?.costUsd).toBeCloseTo(1, 6);
    expect(sep?.costUsd).toBeCloseTo(2, 6);
  });

  it("months is continuous from the first usage month through now, including empty months", () => {
    const first = localMs(2026, 2, 20, 10, 0);
    const now = localMs(2026, 9, 25, 10, 0);
    expect(continuousMonths(first, now)).toEqual([
      "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
  });

  it("months is empty with no usage at all", () => {
    expect(continuousMonths(null, Date.now())).toEqual([]);
  });
});

describe("computeInsights: null-cost / unpriced handling", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("a month whose only rows are unpriced yields costUsd: null with unpricedTokens > 0, never a fabricated 0", () => {
    usage(store, { model: "totally-unknown-model", at: localMs(2026, 6, 5), cost: null, tokens: { input: 100 } });
    const r = computeInsights(store.db, localMs(2026, 6, 10));
    const row = r.byMonthModel.find((m) => m.month === "2026-06");
    expect(row?.costUsd).toBeNull();
    expect(row?.unpricedTokens).toBe(100);
  });

  it("a month mixing priced and unpriced usage keeps the priced partial sum, plus a visible unpricedTokens", () => {
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 6, 5), cost: 1.5 });
    usage(store, { model: "totally-unknown-model", at: localMs(2026, 6, 6), cost: null, tokens: { input: 50 } });
    const r = computeInsights(store.db, localMs(2026, 6, 10));
    // lifetime KPI: the priced row still counts, the unpriced row shows up separately.
    expect(r.kpi.lifetimeUsd).toBeCloseTo(1.5, 6);
    expect(r.meta.unpricedTokens).toBe(50);
    expect(r.meta.unpricedRows).toBe(1);
  });

  it("a window with literally no usage rows is a true 0, not null (nothing happened, vs. unknown price)", () => {
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 6, 5), cost: 1 });
    const r = computeInsights(store.db, localMs(2026, 9, 25));
    const july = r.byMonthKind.filter((k) => k.month === "2026-07");
    for (const k of july) expect(k.costUsd).toBe(0);
  });
});

describe("computeInsights: token classes reconstruct SUM(cost_usd)", () => {
  it("inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd equals the priced total for the month", () => {
    const store = freshStore();
    usage(store, {
      model: "claude-opus-4-8", // $5 / $25 / $0.5 / $6.25 / $10 per MTok
      at: localMs(2026, 6, 5),
      cost: null, // ignored by insights.ts's independent rateFor recompute -- set the real value too:
      tokens: { input: 1_000_000, output: 200_000, cache_read: 500_000, cache_create_5m: 100_000, cache_create_1h: 50_000 },
    });
    // Recompute the "real" stored cost the same way costOf would, so the test
    // doesn't depend on cost_usd at all -- insights.ts must reconstruct this
    // total purely from rateFor(), independent of whatever's stored.
    const expected = (1_000_000 * 5 + 200_000 * 25 + 500_000 * 0.5 + 100_000 * 6.25 + 50_000 * 10) / 1e6;
    const r = computeInsights(store.db, localMs(2026, 6, 10));
    const row = r.byMonthTokenClass.find((m) => m.month === "2026-06")!;
    const total = row.inputUsd + row.outputUsd + row.cacheReadUsd + row.cacheWriteUsd;
    expect(total).toBeCloseTo(expected, 6);
    expect(row.unpricedTokens).toBe(0);
  });

  it("tokenClassUsd is unpriced (contributes 0 to every class) for a model with no rate", () => {
    const cls = tokenClassUsd({ ...zeroTok, input: 100 }, null);
    expect(cls).toEqual({ inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, unpriced: true });
  });
});

describe("kindOf / familyOf", () => {
  it("classifies main / subagent / workflow (a run_id row always implies an agent_id too)", () => {
    expect(kindOf(null, null)).toBe("main");
    expect(kindOf(null, "a1")).toBe("subagent");
    expect(kindOf("wf_1", "a1")).toBe("workflow");
  });

  it("maps model families exactly (fable/mythos/opus/sonnet -> named, everything else -> Other)", () => {
    expect(familyOf("claude-fable-5-1")).toBe("Fable");
    expect(familyOf("claude-mythos-5")).toBe("Fable");
    expect(familyOf("fable")).toBe("Fable");
    expect(familyOf("mythos")).toBe("Fable");
    expect(familyOf("claude-opus-4-8")).toBe("Opus");
    expect(familyOf("opus")).toBe("Opus");
    expect(familyOf("claude-sonnet-5")).toBe("Sonnet");
    expect(familyOf("sonnet")).toBe("Sonnet");
    expect(familyOf("claude-haiku-4-5")).toBe("Other");
    expect(familyOf("gpt-5.5")).toBe("Other");
    expect(familyOf("grok-4.7")).toBe("Other");
    expect(familyOf("cursor-grok-4.6-high")).toBe("Other");
    expect(familyOf("claude-sonnet-5-thinking-high")).toBe("Sonnet"); // Cursor-routed Claude
  });
});

describe("computeInsights: KPI projections", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
    // Aug: $100 total. Sep 1-18: $180 total, trailing 7 days (Sep 19-25): $70.
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 8, 10), cost: 100 });
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 9, 5), cost: 110 });
    for (let d = 19; d <= 25; d++) {
      usage(store, { sessionId: `t${d}`, model: "claude-sonnet-5", at: localMs(2026, 9, d, 10), cost: 10 });
    }
  });

  it("mtdUsd/prevMonthUsd/trailing7dUsd sum the right windows", () => {
    const now = localMs(2026, 9, 25, 18, 0);
    const r = computeInsights(store.db, now);
    expect(r.kpi.mtdUsd).toBeCloseTo(110 + 7 * 10, 6);
    expect(r.kpi.prevMonthUsd).toBeCloseTo(100, 6);
    expect(r.kpi.trailing7dUsd).toBeCloseTo(7 * 10, 6);
  });

  it("projectedMonthEndUsd = MTD + (trailing7d/7) * days remaining in the local month", () => {
    const now = localMs(2026, 9, 25, 0, 0); // exactly 6 days remain until 1 Oct 00:00
    const mtd = 110 + 7 * 10;
    const expected = mtd + (70 / 7) * 6;
    expect(projection(now, mtd, 70)).toBeCloseTo(expected, 6);
  });

  it("projection is null on the first two days of a month", () => {
    expect(projection(localMs(2026, 9, 1, 12), 10, 70)).toBeNull();
    expect(projection(localMs(2026, 9, 2, 23), 10, 70)).toBeNull();
    expect(projection(localMs(2026, 9, 3, 0), 10, 70)).not.toBeNull();
  });

  it("samePointPrevMonth sums the prior month from its start through the same day/time, clamped to a shorter month", () => {
    const rows = [
      { hb: "2026-02-27 10", cost: 5 }, // Feb 27, inside the window
      { hb: "2026-02-28 23", cost: 7 }, // Feb has only 28 days in 2026 (not a leap year)
      { hb: "2026-03-31 10", cost: 100 }, // March, outside the window (different month)
    ];
    // "now" = 31 March 10:00 -> prior month Feb has no 31st, so the window
    // clamps to all of February.
    const now = localMs(2026, 3, 31, 10, 0);
    expect(samePointPrevMonth(rows, now)).toBeCloseTo(12, 6);
  });

  it("samePointPrevMonth's clamp does not leak the current month's own first hour into the prior-month sum", () => {
    const rows = [
      { hb: "2026-02-27 10", cost: 5 },
      { hb: "2026-02-28 23", cost: 7 },
      { hb: "2026-03-01 00", cost: 1000 }, // the CURRENT month's very first hour bucket
    ];
    // Same clamp as above (Feb has no 31st): a `<=` upper bound here would
    // pull the 2026-03-01 00 row into what must read as "all of February"
    // (reviewer finding, reproduced here without needing a live 31st-vs-
    // shorter-month day to actually land data in that exact hour).
    const now = localMs(2026, 3, 31, 10, 0);
    expect(samePointPrevMonth(rows, now)).toBeCloseTo(12, 6);
  });

  it("trailing7dUsd is exact to the second, not the hour: usage minutes before the cutoff is excluded", () => {
    const store = freshStore();
    const now = localMs(2026, 9, 25, 10, 30);
    const cutoff = now - 7 * 24 * 60 * 60 * 1000; // Sep 18, 10:30 -- the trailing-7-day boundary
    usage(store, { model: "claude-sonnet-5", at: cutoff - 5 * 60_000, cost: 52 }); // 10:25, just BEFORE the cutoff, same hour bucket as the cutoff
    usage(store, { model: "claude-sonnet-5", at: cutoff + 5 * 60_000, cost: 10 }); // 10:35, just after the cutoff
    const r = computeInsights(store.db, now);
    // An hour-bucket approximation would pull the whole 10:00-10:59 bucket in
    // and count both rows (62); the exact query counts only the second one.
    expect(r.kpi.trailing7dUsd).toBeCloseTo(10, 6);
  });
});

describe("computeInsights: streaks", () => {
  it("finds the longest island and a current streak that includes today or yesterday", () => {
    const days = ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-05", "2026-09-06"];
    const { longest, current } = streaks(days, "2026-09-06");
    expect(longest).toEqual({ from: "2026-08-30", to: "2026-09-01", days: 3 });
    expect(current).toBe(2); // 09-05, 09-06
  });

  it("current streak is 0 when the last active day is neither today nor yesterday", () => {
    const { current } = streaks(["2026-09-01", "2026-09-02"], "2026-09-10");
    expect(current).toBe(0);
  });

  it("current streak counts a single active day as yesterday", () => {
    const { current } = streaks(["2026-09-05"], "2026-09-06");
    expect(current).toBe(1);
  });

  it("empty input yields no streak at all", () => {
    expect(streaks([], "2026-09-06")).toEqual({ longest: null, current: 0 });
  });
});

describe("computeInsights: peak concurrent agents", () => {
  it("picks the 15-minute bucket with the most distinct agents and names its dominant run", () => {
    const store = freshStore();
    const base = localMs(2026, 9, 7, 15, 15); // aligned to a 15-min boundary
    store.upsertWorkflowRun({ run_id: "wf_big", session_id: "s1", dir: "/x", name: "review-treatment-plan-spa" });
    for (let i = 0; i < 5; i++) {
      usage(store, { sessionId: `parent`, model: "claude-sonnet-5", at: base + i, cost: 1, runId: "wf_big", agentId: `a${i}` });
    }
    usage(store, { sessionId: "solo", model: "claude-sonnet-5", at: localMs(2026, 9, 1, 0, 0), cost: 1 });
    const r = computeInsights(store.db, localMs(2026, 9, 8));
    expect(r.records.peakAgents?.agents).toBe(5);
    expect(r.records.peakAgents?.runId).toBe("wf_big");
    expect(r.records.peakAgents?.runName).toBe("review-treatment-plan-spa");
  });
});

describe("computeInsights: longest session and active-hours union", () => {
  it("splits a session on a 30-minute gap and counts two overlapping sessions' active time once", () => {
    const store = freshStore();
    const t0 = localMs(2026, 6, 1, 9, 0);
    // Session A: two messages 10 min apart (10 min active).
    usage(store, { sessionId: "A", project: "px", model: "claude-sonnet-5", at: t0, cost: 1 });
    usage(store, { sessionId: "A", project: "px", model: "claude-sonnet-5", at: t0 + 10 * 60_000, cost: 1 });
    // Session B: runs the ENTIRE SAME 10-minute window, in parallel.
    usage(store, { sessionId: "B", project: "px", model: "claude-sonnet-5", at: t0, cost: 1 });
    usage(store, { sessionId: "B", project: "px", model: "claude-sonnet-5", at: t0 + 10 * 60_000, cost: 1 });
    // A 40-minute gap afterwards must NOT count as active time for either.
    usage(store, { sessionId: "A", project: "px", model: "claude-sonnet-5", at: t0 + 50 * 60_000, cost: 1 });

    const r = computeInsights(store.db, localMs(2026, 6, 1, 12, 0));
    const june = r.activity.find((a) => a.month === "2026-06")!;
    // The union of A's and B's active windows is still just 10 minutes, not 20.
    expect(june.activeMs).toBe(10 * 60_000);
  });

  it("longestSession uses per-session gaps, not the global union", () => {
    const store = freshStore();
    const t0 = localMs(2026, 8, 25, 9, 0);
    usage(store, { sessionId: "long", project: "lunatic", model: "claude-sonnet-5", at: t0, cost: 1 });
    usage(store, { sessionId: "long", project: "lunatic", model: "claude-sonnet-5", at: t0 + 20 * 60_000, cost: 1 });
    usage(store, { sessionId: "short", project: "other", model: "claude-sonnet-5", at: t0, cost: 1 });
    const r = computeInsights(store.db, localMs(2026, 8, 25, 12, 0));
    expect(r.records.longestSession?.sessionId).toBe("long");
    expect(r.records.longestSession?.project).toBe("lunatic");
    expect(r.records.longestSession?.activeMs).toBe(20 * 60_000);
    expect(r.records.longestSession?.wallMs).toBe(20 * 60_000);
  });
});

describe("computeInsights: workflow runs", () => {
  it("a workflow run with no usage rows at all gets costUsd: null (excluded from the plot, not a fabricated 0)", () => {
    const store = freshStore();
    store.upsertWorkflowRun({ run_id: "wf_empty", session_id: "s1", dir: "/x", started_at: localMs(2026, 9, 1) });
    const r = computeInsights(store.db, localMs(2026, 9, 5));
    const run = r.workflowRuns.find((x) => x.runId === "wf_empty")!;
    expect(run.costUsd).toBeNull();
  });

  it("priciestRun picks the run with the highest recorded cost", () => {
    const store = freshStore();
    store.upsertWorkflowRun({ run_id: "cheap", session_id: "s1", dir: "/x", started_at: localMs(2026, 9, 1), agent_count: 2 });
    store.upsertWorkflowRun({ run_id: "pricey", session_id: "s1", dir: "/x", started_at: localMs(2026, 9, 2), agent_count: 9 });
    usage(store, { model: "claude-opus-5", at: localMs(2026, 9, 1), cost: 5, runId: "cheap", agentId: "a1" });
    usage(store, { model: "claude-opus-5", at: localMs(2026, 9, 2), cost: 116.82, runId: "pricey", agentId: "a1" });
    const r = computeInsights(store.db, localMs(2026, 9, 5));
    expect(r.records.priciestRun?.runId).toBe("pricey");
    expect(r.records.priciestRun?.costUsd).toBeCloseTo(116.82, 6);
  });
});

describe("computeInsights: projects fold (top 10 / Other / no project)", () => {
  it("buckets the top project separately from a folded Other and a (no project) row", () => {
    const store = freshStore();
    usage(store, { sessionId: "big", project: "big-spender", model: "claude-sonnet-5", at: localMs(2026, 6, 1), cost: 100 });
    usage(store, { sessionId: "small", project: "small-fry", model: "claude-sonnet-5", at: localMs(2026, 6, 1), cost: 1 });
    rawUsage(store, { sessionId: "none", model: "claude-sonnet-5", at: localMs(2026, 6, 1), cost: 5 });
    const r = computeInsights(store.db, localMs(2026, 6, 5));
    const names = r.projects.map((p) => p.project);
    expect(names).toContain("big-spender");
    expect(names).toContain("(no project)");
    const noProject = r.projects.find((p) => p.project === "(no project)")!;
    expect(noProject.kind).toBe("none");
    expect(noProject.lifetimeUsd).toBeCloseTo(5, 6);
  });

  it("folds every project past the top 10 into a single Other row, by lifetime spend", () => {
    const store = freshStore();
    for (let i = 0; i < 12; i++) {
      usage(store, {
        sessionId: `s${i}`,
        project: `proj-${i}`,
        model: "claude-sonnet-5",
        at: localMs(2026, 6, 1),
        cost: 100 - i, // strictly descending, so ranking is unambiguous
      });
    }
    const r = computeInsights(store.db, localMs(2026, 6, 5));
    const other = r.projects.find((p) => p.kind === "other")!;
    expect(other).toBeTruthy();
    expect(other.project).toBe("Other 2 projects");
    // proj-10 ($90) and proj-11 ($89) are the two folded in.
    expect(other.lifetimeUsd).toBeCloseTo(90 + 89, 6);
    expect(r.projects.filter((p) => p.kind === "project").length).toBe(10);
  });

  it("counts a session that spans two months once, not once per month, in a project's lifetime sessions", () => {
    const store = freshStore();
    usage(store, { sessionId: "spans", project: "proj-a", model: "claude-sonnet-5", at: localMs(2026, 6, 28), cost: 1 });
    usage(store, { sessionId: "spans", project: "proj-a", model: "claude-sonnet-5", at: localMs(2026, 7, 2), cost: 1 });
    usage(store, { sessionId: "other", project: "proj-a", model: "claude-sonnet-5", at: localMs(2026, 7, 3), cost: 1 });
    const r = computeInsights(store.db, localMs(2026, 7, 5));
    const p = r.projects.find((x) => x.project === "proj-a")!;
    // "spans" counts once even though it has rows in both June and July.
    expect(p.sessions).toBe(2);
  });
});

describe("computeInsights: weekday mapping", () => {
  it("Monday maps to weekday 0 (roving grid convention)", () => {
    const store = freshStore();
    // 2026-09-07 is a Monday.
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 9, 7, 10, 0), cost: 1 });
    const r = computeInsights(store.db, localMs(2026, 9, 8));
    const cell = r.weekHour.find((c) => c.weekday === 0 && c.hour === 10)!;
    expect(cell.activeDays).toBe(1);
  });
});

describe("computeInsights: weekdayCounts across a DST transition", () => {
  it("counts every calendar day exactly once even across the Europe/Berlin spring-forward (29 Mar 2026)", () => {
    const store = freshStore();
    // First usage Wed 25 Mar 2026; "now" Sun 5 Apr 2026 -- a 12-day window
    // straddling the 29 Mar 02:00->03:00 CEST transition. A version that
    // steps by a fixed 24h in ms drifts off local midnight right at the
    // transition and then undercounts whichever weekday "now" falls on
    // (reviewer finding on live data: Saturday read 31 instead of 32).
    usage(store, { model: "claude-sonnet-5", at: localMs(2026, 3, 25, 9, 0), cost: 1 });
    const r = computeInsights(store.db, localMs(2026, 4, 5, 0, 0));
    // Mon..Sun, hand-enumerated over Mar25..Apr5 inclusive (12 days: Wed, Thu,
    // Fri, Sat, Sun, Mon, Tue, Wed, Thu, Fri, Sat, Sun).
    expect(r.weekdayCounts).toEqual([1, 1, 2, 2, 2, 2, 2]);
    expect(r.weekdayCounts.reduce((a, b) => a + b, 0)).toBe(12);
  });
});

describe("computeInsights: response shape / meta", () => {
  it("an empty database returns usageRows: 0 and empty arrays, no throw", () => {
    const store = freshStore();
    const r = computeInsights(store.db, Date.now());
    expect(r.meta.usageRows).toBe(0);
    expect(r.meta.firstAt).toBeNull();
    expect(r.months).toEqual([]);
    expect(r.days).toEqual([]);
    expect(r.kpi.lifetimeUsd).toBe(0);
  });

  it("meta.tz is a resolvable IANA zone", () => {
    const store = freshStore();
    const r = computeInsights(store.db, Date.now());
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: r.meta.tz })).not.toThrow();
  });
});
