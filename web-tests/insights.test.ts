import { describe, it, expect } from "vitest";
import { cumulativeWithCarry, pctDelta, calendarLayout, sparklineFrom, daysInMonth, ymd } from "../src/web/insights.ts";
import { formatDeltaPct } from "../src/web/components/charts/format.ts";
import { niceTicks, logTicks, quantileEdges, binOf } from "../src/web/components/charts/scales.ts";
import type { InsightsDay } from "../src/shared/insights.ts";

function day(d: string, costUsd: number | null): InsightsDay {
  return { day: d, costUsd, messages: 1, sessions: 1, topProject: null, peakAgents: 0 };
}

describe("cumulativeWithCarry", () => {
  it("carries the last cumulative value forward across a gap (step-after, never an interpolated slope)", () => {
    const days = [day("2026-06-01", 10), day("2026-06-03", 5)];
    const out = cumulativeWithCarry(days, "2026-06", 5);
    // day 1: 10, day 2: still 10 (no usage), day 3: 15, day 4/5: still 15.
    expect(out).toEqual([10, 10, 15, 15, 15]);
  });

  it("caps at null beyond the given day (the current month's 'today')", () => {
    const days = [day("2026-09-01", 10)];
    const out = cumulativeWithCarry(days, "2026-09", 5, 1); // 0-based day index 1 = day 2
    expect(out).toEqual([10, 10, null, null, null]);
  });

  it("treats a null-cost (fully unpriced) day as contributing 0, never NaN", () => {
    const days = [day("2026-06-01", null)];
    const out = cumulativeWithCarry(days, "2026-06", 3);
    expect(out).toEqual([0, 0, 0]);
  });
});

describe("pctDelta", () => {
  it("computes a percentage change", () => {
    expect(pctDelta(150, 100)).toBeCloseTo(50, 6);
    expect(pctDelta(50, 100)).toBeCloseTo(-50, 6);
  });

  it("is null when either side is missing or the baseline is zero", () => {
    expect(pctDelta(null, 100)).toBeNull();
    expect(pctDelta(100, null)).toBeNull();
    expect(pctDelta(100, 0)).toBeNull();
  });

  it("is null when the months are not comparable (either is zero, or one is over 10x the other)", () => {
    expect(pctDelta(960, 3)).toBeNull(); // Jun vs a $3 May: "+37500%" says nothing
    expect(pctDelta(0, 11)).toBeNull(); // an empty month after a tiny one
    expect(pctDelta(1000, 100)).toBeCloseTo(900, 6); // exactly 10x is still shown
    expect(pctDelta(1001, 100)).toBeNull();
    expect(pctDelta(10, 100)).toBeCloseTo(-90, 6);
    expect(pctDelta(9, 100)).toBeNull();
  });
});

describe("formatDeltaPct", () => {
  it("follows pctDelta's comparability rule and labels tiny moves flat", () => {
    expect(formatDeltaPct(1887, 960)).toBe("+97%");
    expect(formatDeltaPct(960, 3)).toBeNull();
    expect(formatDeltaPct(0, 11)).toBeNull();
    expect(formatDeltaPct(100.2, 100)).toBe("flat");
  });
});

describe("calendarLayout", () => {
  it("lays out days starting from a Wednesday into the correct week/weekday cells", () => {
    // 2026-08-05 is a Wednesday.
    const cells = calendarLayout("2026-08-05", "2026-08-10");
    const byDay = new Map(cells.map((c) => [c.day, c]));
    expect(byDay.get("2026-08-05")).toEqual({ day: "2026-08-05", week: 0, weekday: 2 }); // Wed = index 2
    expect(byDay.get("2026-08-10")).toEqual({ day: "2026-08-10", week: 1, weekday: 0 }); // the following Monday starts week 1
    expect(byDay.get("2026-08-08")).toMatchObject({ weekday: 5 }); // Saturday
  });

  it("advances the week index across a Monday boundary", () => {
    const cells = calendarLayout("2026-08-05", "2026-08-11"); // through the FOLLOWING Tuesday
    const byDay = new Map(cells.map((c) => [c.day, c]));
    expect(byDay.get("2026-08-11")).toEqual({ day: "2026-08-11", week: 1, weekday: 1 });
  });
});

describe("sparklineFrom", () => {
  it("drops leading months at or below $1, keeping the first real one onward", () => {
    const monthly = [
      { month: "2026-02", value: 0.5 },
      { month: "2026-03", value: 0 },
      { month: "2026-04", value: 3 },
      { month: "2026-05", value: 10 },
    ];
    expect(sparklineFrom(monthly).map((m) => m.month)).toEqual(["2026-04", "2026-05"]);
  });

  it("is empty when no month ever exceeds $1", () => {
    expect(sparklineFrom([{ month: "2026-02", value: 1 }])).toEqual([]);
  });
});

describe("daysInMonth / ymd", () => {
  it("knows February 2026 has 28 days (not a leap year)", () => {
    expect(daysInMonth("2026-02")).toBe(28);
  });
  it("knows a 31-day month", () => {
    expect(daysInMonth("2026-08")).toBe(31);
  });
  it("formats a local Date as YYYY-MM-DD", () => {
    expect(ymd(new Date(2026, 8, 7))).toBe("2026-09-07");
  });
});

describe("chart scale helpers", () => {
  it("niceTicks produces round numbers spanning at least max", () => {
    const ticks = niceTicks(2982, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(2982);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
  });

  it("logTicks spans decades covering [min,max]", () => {
    const ticks = logTicks(0.1, 116.82);
    expect(ticks[0]).toBeCloseTo(0.1, 6);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(116.82);
  });

  it("quantileEdges splits values into 5 bins with monotonic edges, and binOf assigns ties to the same bin", () => {
    const values = [1, 1, 1, 5, 5, 10, 10, 20, 50, 90];
    const edges = quantileEdges(values, 5);
    expect(edges.length).toBe(6);
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1]);
    expect(binOf(1, edges)).toBe(binOf(1, edges)); // ties -> deterministic, same bin every call
    expect(binOf(90, edges)).toBe(4); // the max value always lands in the last bin
  });
});
