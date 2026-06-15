import { describe, it, expect } from "bun:test";
import { parseUsageLine } from "../src/server/usage.ts";

const assistantLine = JSON.stringify({
  type: "assistant",
  uuid: "u-1",
  timestamp: "2026-06-15T08:00:00.000Z",
  message: {
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      iterations: [{ input_tokens: 100, output_tokens: 20 }],
    },
  },
});

describe("parseUsageLine", () => {
  it("extracts uuid, model, tokens, and timestamp", () => {
    const p = parseUsageLine(assistantLine);
    expect(p).not.toBeNull();
    expect(p!.uuid).toBe("u-1");
    expect(p!.model).toBe("claude-opus-4-8");
    expect(p!.tokens).toEqual({
      input: 100, output: 20, cache_read: 1000, cache_create_5m: 100, cache_create_1h: 200,
    });
    expect(p!.at).toBe(Date.parse("2026-06-15T08:00:00.000Z"));
  });

  it("returns null for lines without usage (user / tool_result lines)", () => {
    expect(parseUsageLine(JSON.stringify({ type: "user", uuid: "x", message: { role: "user", content: "hi" } }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseUsageLine("{not json")).toBeNull();
  });

  it("defaults missing cache_creation split to 0", () => {
    const line = JSON.stringify({
      uuid: "u-2", timestamp: "2026-06-15T08:00:00.000Z",
      message: { model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 1 } },
    });
    const p = parseUsageLine(line)!;
    expect(p.tokens).toEqual({ input: 5, output: 1, cache_read: 0, cache_create_5m: 0, cache_create_1h: 0 });
  });
});
