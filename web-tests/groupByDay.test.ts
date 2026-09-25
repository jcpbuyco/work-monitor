import { describe, it, expect } from "vitest";
import { groupByDay } from "../src/web/groupByDay.ts";

interface Row {
  id: string;
  day: string;
}

const r = (id: string, day: string): Row => ({ id, day });

describe("groupByDay", () => {
  it("buckets contiguous same-day rows together, preserving their relative order", () => {
    const rows = [r("a", "2026-06-16"), r("b", "2026-06-16"), r("c", "2026-06-15")];
    const groups = groupByDay(rows, (x) => x.day, true);
    expect(groups.map((g) => g.day)).toEqual(["2026-06-16", "2026-06-15"]);
    expect(groups[0].rows.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("dateSortActive=true keeps the caller's own day order verbatim, ascending included", () => {
    const rows = [r("old", "2026-06-14"), r("mid", "2026-06-15"), r("new", "2026-06-16")];
    const groups = groupByDay(rows, (x) => x.day, true);
    expect(groups.map((g) => g.day)).toEqual(["2026-06-14", "2026-06-15", "2026-06-16"]); // ascending, as given
  });

  it("dateSortActive=false always orders groups newest-first, regardless of row order", () => {
    // rows arrive interleaved (e.g. sorted by cost, not by date)
    const rows = [r("mid-cost", "2026-06-14"), r("new-cost", "2026-06-16"), r("old-cost", "2026-06-15")];
    const groups = groupByDay(rows, (x) => x.day, false);
    expect(groups.map((g) => g.day)).toEqual(["2026-06-16", "2026-06-15", "2026-06-14"]);
  });

  it("an 'unknown' bucket always sorts last, never first, under either mode", () => {
    const rows = [r("u", "unknown"), r("a", "2026-06-16")];
    expect(groupByDay(rows, (x) => x.day, false).map((g) => g.day)).toEqual(["2026-06-16", "unknown"]);
    expect(groupByDay(rows, (x) => x.day, true).map((g) => g.day)).toEqual(["unknown", "2026-06-16"]); // verbatim order still respects "last" here since it's the input order
  });

  it("returns one group per distinct day when nothing repeats", () => {
    const rows = [r("a", "2026-06-16")];
    expect(groupByDay(rows, (x) => x.day, false)).toEqual([{ day: "2026-06-16", rows: [rows[0]] }]);
  });

  it("returns no groups for an empty input", () => {
    expect(groupByDay([], (x: Row) => x.day, false)).toEqual([]);
  });
});
