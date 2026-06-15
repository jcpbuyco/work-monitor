import { describe, it, expect } from "bun:test";
import { costOf, canonicalModel, type Tokens } from "../src/server/pricing.ts";

const zero: Tokens = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };

describe("costOf", () => {
  it("prices input and output at the model's per-MTok rate", () => {
    // Opus 4.8: $5 / $25 per MTok
    const c = costOf("claude-opus-4-8", { ...zero, input: 1_000_000, output: 1_000_000 });
    expect(c).toBeCloseTo(5 + 25, 6);
  });

  it("applies cache multipliers to the input rate (read 0.1x, 5m 1.25x, 1h 2x)", () => {
    const c = costOf("claude-opus-4-8", {
      ...zero,
      cache_read: 1_000_000,
      cache_create_5m: 1_000_000,
      cache_create_1h: 1_000_000,
    });
    // 5 * (0.1 + 1.25 + 2.0)
    expect(c).toBeCloseTo(5 * 3.35, 6);
  });

  it("uses the right rate per model", () => {
    expect(costOf("claude-haiku-4-5", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
    expect(costOf("claude-sonnet-4-6", { ...zero, output: 1_000_000 })).toBeCloseTo(15, 6);
    expect(costOf("claude-fable-5", { ...zero, output: 1_000_000 })).toBeCloseTo(50, 6);
  });

  it("returns 0 for an unknown model", () => {
    expect(costOf("gpt-9", { ...zero, input: 1_000_000 })).toBe(0);
  });

  it("prices date-suffixed model ids like their canonical id", () => {
    // real transcripts emit e.g. claude-haiku-4-5-20251001 → price as haiku ($1/$5)
    expect(costOf("claude-haiku-4-5-20251001", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
  });

  it("prices bare family aliases at the tier rate", () => {
    expect(costOf("opus", { ...zero, input: 1_000_000 })).toBeCloseTo(5, 6);
    expect(costOf("sonnet", { ...zero, output: 1_000_000 })).toBeCloseTo(15, 6);
    expect(costOf("haiku", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
  });
});

describe("canonicalModel", () => {
  it("strips a trailing date snapshot suffix", () => {
    expect(canonicalModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });
  it("maps bare family aliases to a canonical id", () => {
    expect(canonicalModel("opus")).toBe("claude-opus-4-8");
    expect(canonicalModel("sonnet")).toBe("claude-sonnet-4-6");
    expect(canonicalModel("haiku")).toBe("claude-haiku-4-5");
  });
  it("passes canonical and unknown ids through unchanged", () => {
    expect(canonicalModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalModel("gpt-9")).toBe("gpt-9");
  });
});
