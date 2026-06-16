import { describe, it, expect } from "vitest";
import { formatUsd, formatTokens, prettyModel, formatDay, costDailyRange } from "../src/web/cost.ts";

describe("formatUsd", () => {
  it("formats dollars with two decimals", () => {
    expect(formatUsd(3.714)).toBe("$3.71");
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("shows a floor for tiny non-zero amounts", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
  });
});

describe("formatTokens", () => {
  it("uses K / M suffixes", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(312_000)).toBe("312K");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
});

describe("prettyModel", () => {
  it("turns model ids into display names", () => {
    expect(prettyModel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(prettyModel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(prettyModel("claude-fable-5")).toBe("Fable 5");
  });
  it("strips a trailing date snapshot suffix", () => {
    expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
});

describe("formatDay", () => {
  it("formats an ISO day as 'Mon D'", () => {
    expect(formatDay("2026-06-16")).toBe("Jun 16");
    expect(formatDay("2026-01-01")).toBe("Jan 1");
  });
  it("returns the input unchanged when not an ISO day", () => {
    expect(formatDay("nope")).toBe("nope");
  });
});

describe("costDailyRange", () => {
  it("7-day window starts at local midnight 6 days before today", () => {
    const now = new Date(2026, 5, 16, 13, 30).getTime(); // local Jun 16 13:30
    const expected = new Date(2026, 5, 10, 0, 0, 0, 0).getTime(); // local Jun 10 00:00
    expect(costDailyRange(7, now).since).toBe(expected);
  });
  it("'all' has no lower bound", () => {
    expect(costDailyRange("all", Date.now())).toEqual({});
  });
});
