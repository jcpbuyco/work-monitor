import { describe, it, expect } from "vitest";
import { formatUsd, formatUsdWhole, formatTokens, prettyModel, formatDay, costDailyRange } from "../src/web/cost.ts";

describe("formatUsd", () => {
  it("formats dollars with two decimals", () => {
    expect(formatUsd(3.714)).toBe("$3.71");
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("shows a floor for tiny non-zero amounts", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
  });
  it("renders null (unpriced) as a word, never a crash or a fabricated $0.00", () => {
    expect(formatUsd(null)).toBe("unpriced");
  });
});

describe("formatTokens", () => {
  it("uses K / M suffixes", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(312_000)).toBe("312K");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
  it("uses a B suffix at a billion, so an Insights-page lifetime total never prints as an unreadable 4-digit M figure", () => {
    expect(formatTokens(14_786_528_150)).toBe("14.79B");
    expect(formatTokens(1_000_000_000)).toBe("1.00B");
  });
});

describe("formatUsdWhole", () => {
  it("rounds to whole dollars with a thousands separator, for a big standalone figure", () => {
    expect(formatUsdWhole(10800.21)).toBe("$10,800");
    expect(formatUsdWhole(4957.4)).toBe("$4,957");
    expect(formatUsdWhole(590)).toBe("$590");
  });
  it("renders null the same 'unpriced' way formatUsd does", () => {
    expect(formatUsdWhole(null)).toBe("unpriced");
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
  it("keeps GPT's conventional hyphen instead of a space (§5.1 model pill)", () => {
    expect(prettyModel("gpt-5.5")).toBe("GPT-5.5");
    expect(prettyModel("gpt-5.3-codex")).toBe("GPT-5.3.codex");
  });
  it("space-separates a non-Claude, non-GPT family like Grok", () => {
    expect(prettyModel("grok-4.7")).toBe("Grok 4.7");
  });
  it("renders a bracket-suffixed context-window id as 'Name Ver · SUFFIX' (§5.3)", () => {
    expect(prettyModel("claude-opus-5-5[1m]")).toBe("Opus 5.5 · 1M");
    expect(prettyModel("claude-opus-5[1m]")).toBe("Opus 5 · 1M");
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
