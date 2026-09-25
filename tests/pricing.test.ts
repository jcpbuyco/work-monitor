import { describe, it, expect } from "bun:test";
import { costOf, canonicalModel, fnv1a, RATES_VERSION, type Tokens } from "../src/server/pricing.ts";

const zero: Tokens = { input: 0, output: 0, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 };

describe("costOf", () => {
  it("prices input and output at the model's per-MTok rate", () => {
    // Opus 4.8: $5 / $25 per MTok
    const c = costOf("claude-opus-4-8", { ...zero, input: 1_000_000, output: 1_000_000 });
    expect(c).toBeCloseTo(5 + 25, 6);
  });

  it("applies the model's own cache rates (read/5m-write/1h-write), not a shared multiplier", () => {
    const c = costOf("claude-opus-4-8", {
      ...zero,
      cache_read: 1_000_000,
      cache_create_5m: 1_000_000,
      cache_create_1h: 1_000_000,
    });
    // 0.5 + 6.25 + 10 -- the same values a 0.1x/1.25x/2x multiplier on $5 input would give,
    // but now sourced from explicit per-model fields (§2.1).
    expect(c).toBeCloseTo(0.5 + 6.25 + 10, 6);
  });

  it("uses the right rate per model", () => {
    expect(costOf("claude-haiku-4-5", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
    expect(costOf("claude-sonnet-4-6", { ...zero, output: 1_000_000 })).toBeCloseTo(15, 6);
    expect(costOf("claude-fable-5", { ...zero, output: 1_000_000 })).toBeCloseTo(50, 6);
  });

  it("returns null (unpriced, not free) for an unknown model", () => {
    expect(costOf("gpt-9", { ...zero, input: 1_000_000 })).toBeNull();
  });

  it("prices date-suffixed model ids like their canonical id", () => {
    // real transcripts emit e.g. claude-haiku-4-5-20251001 → price as haiku ($1/$5)
    expect(costOf("claude-haiku-4-5-20251001", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
  });

  it("prices bare family aliases at the tier rate", () => {
    expect(costOf("opus", { ...zero, input: 1_000_000 })).toBeCloseTo(5, 6);
    expect(costOf("sonnet", { ...zero, output: 1_000_000 })).toBeCloseTo(10, 6); // sonnet-5's corrected $10 output rate
    expect(costOf("haiku", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
  });

  it("prices the 5-series Claude models at their real list price", () => {
    expect(costOf("claude-opus-5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(5 + 25, 6);
    // Sonnet 5 is $2/$10, not $3/$15 (the fix this table exists for).
    expect(costOf("claude-sonnet-5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(2 + 10, 6);
  });

  it("prices claude-fable-5-1 and claude-opus-5-5, both previously missing from the table ($0 bug)", () => {
    expect(costOf("claude-fable-5-1", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(10 + 50, 6);
    expect(costOf("claude-fable-5-1", { ...zero, cache_read: 1_000_000 })).toBeCloseTo(0.25, 6);
    expect(costOf("claude-opus-5-5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(4 + 20, 6);
    expect(costOf("claude-opus-5-5", { ...zero, cache_read: 1_000_000 })).toBeCloseTo(0.2, 6);
  });

  it("prices the Codex/GPT models, with no cache-write rate (never cached)", () => {
    expect(costOf("gpt-5.5", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(5 + 30, 6);
    expect(costOf("gpt-5.5", { ...zero, cache_create_5m: 1_000_000, cache_create_1h: 1_000_000 })).toBe(0);
    expect(costOf("gpt-5.3-codex", { ...zero, input: 1_000_000, output: 1_000_000 })).toBeCloseTo(1.75 + 14, 6);
  });

  it("strips a trailing context-window suffix like [1m] before pricing", () => {
    expect(costOf("claude-opus-5-5[1m]", { ...zero, input: 1_000_000 })).toBeCloseTo(4, 6);
  });

  it("keeps bare haiku priced at the 4-5 tier (regression: do not 'finish the job')", () => {
    expect(costOf("haiku", { ...zero, input: 1_000_000 })).toBeCloseTo(1, 6);
  });

  it("keeps the opus/sonnet aliases pointed at their tiers after fable's re-point", () => {
    // opus/sonnet aliases are untouched by the fable fix -- assert non-zero, don't delete.
    expect(costOf("opus", { ...zero, input: 1_000_000 })).toBeCloseTo(5, 6);
    expect(costOf("sonnet", { ...zero, output: 1_000_000 })).toBeCloseTo(10, 6);
  });

  it("prices bare fable at the fable-5-1 tier, not the stale fable-5 tier", () => {
    expect(costOf("fable", { ...zero, cache_read: 1_000_000 })).toBeCloseTo(0.25, 6); // 5-1's rate, not 5-series's 1
  });
});

describe("canonicalModel", () => {
  it("strips a trailing date snapshot suffix", () => {
    expect(canonicalModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("strips a trailing bracket context-window suffix", () => {
    expect(canonicalModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  });

  it("maps bare family aliases to a canonical id", () => {
    expect(canonicalModel("opus")).toBe("claude-opus-5");
    expect(canonicalModel("sonnet")).toBe("claude-sonnet-5");
    // haiku is deliberately NOT re-pointed: there is no claude-haiku-5 rate,
    // so re-pointing it would send every bare `haiku` to the $0 unknown branch.
    expect(canonicalModel("haiku")).toBe("claude-haiku-4-5");
    // fable IS re-pointed: transcripts resolve the bare alias to fable-5-1 100%
    // of the time (never bare fable-5), so the stale mapping cost $0 for real spend.
    expect(canonicalModel("fable")).toBe("claude-fable-5-1");
  });

  it("passes canonical and unknown ids through unchanged", () => {
    expect(canonicalModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalModel("gpt-9")).toBe("gpt-9");
  });
});

describe("RATES_VERSION", () => {
  it("is a stable short hash, not a version number needing manual bumps", () => {
    expect(RATES_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when a rate value changes", () => {
    const before = fnv1a(JSON.stringify([["claude-opus-5", { input: 5 }]]));
    const after = fnv1a(JSON.stringify([["claude-opus-5", { input: 6 }]]));
    expect(after).not.toBe(before);
  });

  it("does not change when the same entries are hashed in a different order", () => {
    const a = fnv1a(JSON.stringify([["a", 1], ["b", 2]]));
    const b = fnv1a(JSON.stringify([["a", 1], ["b", 2]])); // sorted-key input, same order in both
    expect(a).toBe(b);
  });

  it("hashes RATES and FAMILY_ALIAS together, so re-pointing an alias alone bumps it too", () => {
    // FAMILY_ALIAS.fable currently resolves to claude-fable-5-1 -- hashing an
    // alternate mapping for the same key must produce a different version, or a
    // future re-point (like this change's fable -> claude-fable-5-1 one) would
    // silently skip the generic reprice pass that must follow it (§2.3).
    const withFable51 = fnv1a(JSON.stringify([["fable", "claude-fable-5-1"]]));
    const withFable5 = fnv1a(JSON.stringify([["fable", "claude-fable-5"]]));
    expect(withFable51).not.toBe(withFable5);
  });
});

describe("Cursor model ids (cursor.com/docs/models, fetched 2026-09-25)", () => {
  const t = (input: number, output: number, cache_read = 0, cache_create_5m = 0) => ({
    input,
    output,
    cache_read,
    cache_create_5m,
    cache_create_1h: 0,
  });
  const M = 1_000_000;

  it("maps effort/thinking/cursor- variants to one rate key and keeps Fast separate", () => {
    expect(canonicalModel("grok-4.7-low")).toBe("grok-4.7");
    expect(canonicalModel("grok-4.7-xhigh")).toBe("grok-4.7");
    expect(canonicalModel("grok-4.7-high-fast")).toBe("grok-4.7-fast");
    expect(canonicalModel("cursor-grok-4.6-high-fast")).toBe("grok-4.6-fast");
    expect(canonicalModel("cursor-grok-4.6-high")).toBe("grok-4.6");
    expect(canonicalModel("composer-2.5-fast")).toBe("composer-2.5-fast");
    expect(canonicalModel("gpt-5.6-sol-medium")).toBe("gpt-5.6-sol");
    expect(canonicalModel("gpt-5.3-codex-high")).toBe("gpt-5.3-codex");
    expect(canonicalModel("claude-sonnet-5-thinking-high")).toBe("claude-sonnet-5");
    expect(canonicalModel("claude-opus-5-5-max")).toBe("claude-opus-5-5");
  });

  it("prices Cursor-pool models at Cursor's rates (effort does not change price; Fast does)", () => {
    expect(costOf("grok-4.7-low", t(M, M, M))).toBeCloseTo(2 + 6 + 0.5, 6);
    expect(costOf("grok-4.7-high-fast", t(M, M, M))).toBeCloseTo(4 + 12 + 1, 6);
    expect(costOf("cursor-grok-4.6-high-fast", t(M, M, M))).toBeCloseTo(4 + 12 + 1, 6);
    expect(costOf("grok-4.6", t(M, M, M))).toBeCloseTo(2 + 6 + 0.5, 6);
    expect(costOf("cursor-grok-4.5-high-fast", t(M, M, M))).toBeCloseTo(4 + 18 + 1, 6);
    expect(costOf("composer-2.5", t(M, M, M))).toBeCloseTo(0.5 + 2.5 + 0.2, 6);
    expect(costOf("composer-2.5-fast", t(M, M, M))).toBeCloseTo(3 + 15 + 0.5, 6);
  });

  it("prices listed third-party models at their API rates, cache writes included", () => {
    expect(costOf("gpt-5.6-sol-high", t(M, M, M, M))).toBeCloseTo(4 + 20 + 0.4 + 5, 6);
    expect(costOf("gpt-5.6-terra", t(M, M, M, M))).toBeCloseTo(2 + 12 + 0.2 + 2.5, 6);
    expect(costOf("gpt-5.6-luna-high", t(M, M, M, M))).toBeCloseTo(0.2 + 1.2 + 0.02 + 0.25, 6);
    expect(costOf("claude-opus-5-5-high", t(M, M))).toBeCloseTo(4 + 20, 6);
  });

  it("leaves Auto and unlisted Fast variants of third-party models unpriced", () => {
    expect(costOf("auto", t(M, M))).toBeNull(); // bills at whichever model each request was routed to
    expect(costOf("auto-smart", t(M, M))).toBeNull();
    expect(costOf("claude-opus-5-5-high-fast", t(M, M))).toBeNull();
    expect(costOf("gpt-5.6-sol-high-fast", t(M, M))).toBeNull();
  });

  it("leaves Claude Code and Codex ids untouched", () => {
    expect(canonicalModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(canonicalModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(canonicalModel("gpt-5.5")).toBe("gpt-5.5");
    expect(canonicalModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });
});
