import { describe, it, expect } from "vitest";
import { ago, formatDuration, formatWhen, localDayKey, dayGroupLabel } from "../src/web/time.ts";

describe("formatDuration", () => {
  it("formats sub-minute, sub-hour and multi-hour spans", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
  });
  it("renders a dash for null or negative input", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(-5)).toBe("-");
  });
  it("renders anything under 1s as '<1s', never a misleading '0s' (§5.2)", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(11)).toBe("<1s");
    expect(formatDuration(950)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
    expect(formatDuration(1000)).toBe("1s");
  });
});

describe("ago", () => {
  it("formats sub-minute, sub-hour and sub-day spans", () => {
    const now = Date.now();
    expect(ago(now)).toBe("0s ago");
    expect(ago(now - 45_000)).toBe("45s ago");
    expect(ago(now - 5 * 60_000)).toBe("5m ago");
    expect(ago(now - 3 * 3_600_000)).toBe("3h ago");
  });
  it("gains a day unit between 1 and 6 days", () => {
    const now = Date.now();
    expect(ago(now - 2 * 86_400_000)).toBe("2d ago");
    expect(ago(now - 6 * 86_400_000)).toBe("6d ago");
  });
  it("switches to an absolute date past 7 days, instead of a vague week count", () => {
    const now = new Date(2026, 5, 20, 10, 0, 0).getTime();
    const eightDaysAgo = now - 8 * 86_400_000; // Jun 12
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(ago(eightDaysAgo)).toBe("Jun 12");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("formatWhen", () => {
  it("formats an epoch-ms instant as 'Mon D HH:MM' in local time", () => {
    const t = new Date(2026, 5, 16, 14, 3).getTime();
    expect(formatWhen(t)).toBe("Jun 16 14:03");
  });
  it("renders a dash for null", () => {
    expect(formatWhen(null)).toBe("-");
  });
});

describe("localDayKey", () => {
  it("formats an epoch-ms instant as 'YYYY-MM-DD' in local time", () => {
    expect(localDayKey(new Date(2026, 5, 16, 23, 59).getTime())).toBe("2026-06-16");
    expect(localDayKey(new Date(2026, 0, 1, 0, 0).getTime())).toBe("2026-01-01");
  });
});

describe("dayGroupLabel (§5.3 day grouping)", () => {
  const now = new Date(2026, 5, 16, 10, 0).getTime();
  it("labels today and yesterday relative to nowMs", () => {
    expect(dayGroupLabel("2026-06-16", now)).toBe("Today");
    expect(dayGroupLabel("2026-06-15", now)).toBe("Yesterday");
  });
  it("falls back to 'Mon D' for any other day", () => {
    expect(dayGroupLabel("2026-06-10", now)).toBe("Jun 10");
  });
  it("labels the catch-all 'unknown' bucket as 'Unknown date'", () => {
    expect(dayGroupLabel("unknown", now)).toBe("Unknown date");
  });
});
