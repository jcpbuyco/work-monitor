import { describe, it, expect } from "vitest";
import { formatUsd, formatTokens, prettyModel } from "../src/web/cost.ts";

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
});
