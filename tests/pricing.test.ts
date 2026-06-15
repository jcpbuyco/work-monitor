import { describe, it, expect } from "bun:test";
import { costOf, type Tokens } from "../src/server/pricing.ts";

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
});
